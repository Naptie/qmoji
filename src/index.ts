import { NCWebsocket } from 'node-napcat-ts';
import type { AllHandlers, ImageSegment, SendMessageSegment, TextSegment } from 'node-napcat-ts';
import {
  insertImage,
  closeDb,
  getImagesByUser,
  getImagesByNameAndUser,
  type ImageRecord,
  clearImagesByNameAndUserId,
  deleteImageById,
  transferImagesOwnership,
  incrementUseCount,
  getAllImages
} from './db.js';
import {
  deleteImage,
  downloadImage,
  allowlist,
  allowlistPath,
  random,
  formatBytes
} from './utils.js';
import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';
import config from '../config.json' with { type: 'json' };
import { stat } from 'fs/promises';

const napcat = new NCWebsocket(
  {
    baseUrl: config.napcatWs,
    accessToken: config.napcatToken,
    throwPromise: true,
    reconnection: {
      enable: true,
      attempts: 10,
      delay: 5000
    }
  },
  false
);

// Small generic signallable promise: call `signal()` to resolve the promise.
const createSignallable = <T>() => {
  // start with a noop resolver to avoid definite-assignment / non-null assertions
  let resolver: (value: T) => void = () => undefined as unknown as void;
  const promise = new Promise<T>((resolve) => {
    resolver = resolve;
  });
  return {
    promise,
    signal(value: T) {
      resolver(value);
    }
  } as { promise: Promise<T>; signal: (value: T) => void };
};

const getUserName = async (id: number) => {
  if (!id || isNaN(id)) return id.toString();
  const user = await napcat.get_stranger_info({ user_id: id });
  return user?.nickname ? `${user.nickname} (${id})` : id.toString();
};

const getGroupName = async (id: number) => {
  const group = await napcat.get_group_info({ group_id: id });
  return group?.group_name ? `${group.group_name} (${id})` : id.toString();
};

const getEmoji = async (image: ImageRecord, showName = false) => {
  try {
    const fullPath = resolve(process.cwd(), image.file_path);
    const buffer = await readFile(fullPath);
    const base64 = buffer.toString('base64');
    return {
      type: 'image',
      data: {
        summary: `[${showName ? image.name : '动画表情'}]`,
        sub_type: 1 as unknown as string,
        file: `base64://${base64}`
      }
    } satisfies ImageSegment;
  } catch (err) {
    console.error(`[qmoji] Failed to read image ${image.file_path}:`, err);
    return {
      type: 'text',
      data: { text: `无法读取表情文件: ${image.file_path}\n` }
    } satisfies TextSegment;
  }
};

const getEmojiList = async (
  name: string,
  images: ImageRecord[],
  showIndex = false,
  showSensitiveSaveInfo = false,
  groupId: number | null = null,
  count?: number
): Promise<SendMessageSegment[]> => {
  const totalUses = images.reduce((sum, img) => sum + img.use_count, 0);
  let saveInfo = '';
  const segments = (
    await Promise.all(
      images.map(async (img, i) => {
        const imgSegment = await getEmoji(img);
        const ownershipLabel =
          img.user_id === 'global' ? ' (全局)' : img.user_id.startsWith('chat-') ? ' (群聊)' : '';
        const useCountInfo = ` (${img.use_count} 次)`;
        const savedById = parseInt(img.saved_by);
        const savedFromId = img.saved_from ? parseInt(img.saved_from) : null;
        const savedByInfo =
          (savedFromId === groupId || showSensitiveSaveInfo) && !isNaN(savedById)
            ? ` - 由 ${await getUserName(savedById)} 保存`
            : '';
        const savedFromInfo =
          savedFromId !== groupId && showSensitiveSaveInfo && savedFromId
            ? `于群 ${await getGroupName(savedFromId)}`
            : '';
        if (i === 0) saveInfo = `${savedByInfo}${savedFromInfo}`;

        return showIndex
          ? [
              {
                type: 'text',
                data: {
                  text: `${i + 1}.${ownershipLabel}${useCountInfo}${savedByInfo}${savedFromInfo}\n`
                }
              } satisfies TextSegment,
              imgSegment
            ]
          : [imgSegment];
      })
    )
  ).flat();

  return [
    {
      type: 'text',
      data: {
        text: `「${name}」(${images.every((i) => i.user_id === 'global') ? '全局, ' : images.every((i) => i.user_id.startsWith('chat-')) ? '群聊, ' : ''}共 ${count !== undefined ? count : images.length} 个, 使用 ${totalUses} 次)${saveInfo ? `\n${saveInfo}` : ''}\n`
      }
    },
    ...segments
  ];
};

const deleteEmoji = (context: AllHandlers['message'], image: ImageRecord) => {
  const userImages = getImagesByUser(context.user_id.toString());
  if (!userImages.find((img) => img.file_path === image.file_path)) {
    deleteImage(image.file_path);
  }
};

const send = async (context: AllHandlers['message'], ...segments: SendMessageSegment[]) => {
  if (context.message_type === 'group') {
    return await napcat.send_msg({
      group_id: context.group_id,
      message: segments
    });
  } else {
    return await napcat.send_msg({
      user_id: context.user_id,
      message: segments
    });
  }
};

const socketClose = createSignallable<void>();

napcat.on('socket.open', () => {
  console.log('[NapCat] Connected.');
});

napcat.on('socket.close', () => {
  console.log('[NapCat] Disconnected.');
  try {
    socketClose.signal(undefined);
  } catch {
    // ignore if already resolved
  }
});

napcat.on('message', async (context: AllHandlers['message']) => {
  try {
    if (
      !allowlist.users?.includes(context.user_id) &&
      (!('group_id' in context) || !allowlist.groups?.includes(context.group_id))
    ) {
      return;
    }
    const message = context.message.find((m) => m.type === 'text');
    if (message) {
      const text = message.data.text;
      const segments = text
        .split(/\s+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      if (!segments.length) return;
      const command = segments[0];
      if ([...command].every((char) => char === command[0])) return;
      const isAdmin = config.admins?.includes(context.user_id);
      const isGroupChat = context.message_type === 'group';
      if (config.prefixes.utils.includes(command)) {
        const subcommand = segments[1] || '';
        if (!subcommand) {
          await send(context, {
            type: 'text',
            data: {
              text:
                `${command} list [页数] [p/私/自][c/群][g/公/全] - 列出已保存的表情\n` +
                `${command} {clear/cl} <名称> - 清除指定名称的所有个人表情\n` +
                `${command} {cleargroup/cgr} <名称> - 清除指定名称的所有群聊表情\n` +
                `${command} {remove/delete/rm} <名称> <序号> - 删除指定名称的某个表情\n` +
                `${command} {transfer/mv} {group/global} <名称> [序号] - 转移指定名称的 (某个) 个人表情\n` +
                `${command} enable - 在当前群启用 qmoji (允许所有群成员使用)\n` +
                `${command} disable - 在当前群禁用 qmoji (仅允许名单中的用户可用)\n` +
                `${command} <名称> - 列出指定名称的所有表情\n` +
                `保存个人表情：在回复的消息中使用 ${config.prefixes.save[0]}<名称> 进行保存\n` +
                `保存群聊表情：在回复的消息中使用 ${config.prefixes.groupSave[0]}<名称> 进行保存\n` +
                `保存全局表情：在回复的消息中使用 ${config.prefixes.globalSave[0]}<名称> 进行保存\n` +
                `使用表情：在消息中使用 ${config.prefixes.use[0]}<名称> 进行发送`
            }
          });
          return;
        }
        if ((subcommand === 'enable' || subcommand === 'disable') && isGroupChat) {
          const isEnable = subcommand === 'enable';
          const exists = allowlist.groups?.includes(context.group_id);
          if (isEnable && exists) {
            await send(context, {
              type: 'text',
              data: { text: `本群已在允许名单中，无需重复添加。` }
            });
            return;
          }
          if (!isEnable && !exists) {
            await send(context, {
              type: 'text',
              data: { text: `本群不在允许名单中，无需移除。` }
            });
            return;
          }
          if (!allowlist.groups) {
            allowlist.groups = [];
          }
          if (isEnable) {
            allowlist.groups.push(context.group_id);
            await send(context, {
              type: 'text',
              data: { text: `已将本群添加到允许名单。` }
            });
          } else {
            allowlist.groups = allowlist.groups.filter((id) => id !== context.group_id);
            await send(context, {
              type: 'text',
              data: { text: `已将本群从允许名单中移除。` }
            });
          }
          await writeFile(allowlistPath, JSON.stringify(allowlist), 'utf-8');
          console.log(`[qmoji] Updated group allowlist: ${await getGroupName(context.group_id)}`);
          return;
        }
        if (subcommand === 'allowlist' && isAdmin) {
          const operation = segments[2] || '';
          if (!operation) {
            await send(context, {
              type: 'text',
              data: {
                text:
                  'qmoji 允许名单\n' +
                  `用户：\n${allowlist.users ? (await Promise.all(allowlist.users.map(async (id) => `- ${await getUserName(id)}`))).join('\n') : '无'}\n` +
                  `群聊：\n${allowlist.groups ? (await Promise.all(allowlist.groups.map(async (id) => `- ${await getGroupName(id)}`))).join('\n') : '无'}`
              }
            });
            return;
          }
          if (operation !== 'add' && operation !== 'remove') {
            await send(context, {
              type: 'text',
              data: {
                text: `用法：${command} ${subcommand} [add/remove]`
              }
            });
            return;
          }
          const mention = context.message.find((m) => m.type === 'at');
          if (!mention) {
            await send(context, {
              type: 'text',
              data: {
                text: `请提及需要操作的用户。用法：${command} ${subcommand} ${operation} @用户`
              }
            });
            return;
          }
          const targetId = parseInt(mention.data.qq);
          const target = await getUserName(targetId);
          if (isNaN(targetId)) {
            await send(context, {
              type: 'text',
              data: { text: `无法识别提及的用户。` }
            });
            return;
          }
          if (operation === 'add') {
            if (allowlist.users?.includes(targetId)) {
              await send(context, {
                type: 'text',
                data: { text: `用户 ${target} 已在允许名单中。` }
              });
              return;
            }
            if (!allowlist.users) {
              allowlist.users = [];
            }
            allowlist.users.push(targetId);
            await send(context, {
              type: 'text',
              data: { text: `已将用户 ${target} 添加到允许名单。` }
            });
          } else if (operation === 'remove') {
            if (!allowlist.users?.includes(targetId)) {
              await send(context, {
                type: 'text',
                data: { text: `用户 ${target} 不在允许名单中。` }
              });
              return;
            }
            allowlist.users = allowlist.users.filter((id) => id !== targetId);
            await send(context, {
              type: 'text',
              data: { text: `已将用户 ${target} 从允许名单中移除。` }
            });
          }
          await writeFile(allowlistPath, JSON.stringify(allowlist), 'utf-8');
          console.log(`[qmoji] Updated user allowlist: ${await getUserName(targetId)}`);
          return;
        }
        if (subcommand === 'stats' && isAdmin) {
          const statsMap = new Map<
            string,
            { userId: string; count: number; totalUses: number; totalSize: number }
          >();
          const results = await Promise.all(
            getAllImages().map(async (img) => {
              try {
                const fullPath = resolve(process.cwd(), img.file_path);
                const fileStats = await stat(fullPath);
                const size = fileStats.size;
                return { userId: img.user_id, useCount: img.use_count, size };
              } catch (err) {
                console.error(`[qmoji] Failed to stat image ${img.file_path}:`, err);
                return { userId: img.user_id, useCount: img.use_count, size: 0 };
              }
            })
          );
          for (const { userId, useCount, size } of results) {
            if (!statsMap.has(userId)) {
              statsMap.set(userId, {
                userId,
                count: 1,
                totalUses: useCount,
                totalSize: size
              });
            } else {
              statsMap.get(userId)!.count += 1;
              statsMap.get(userId)!.totalUses += useCount;
              statsMap.get(userId)!.totalSize += size;
            }
          }
          const stats = (
            await Promise.all(
              Array.from(statsMap.entries()).map(async ([id, info]) =>
                id === 'global'
                  ? { type: 1, name: null, ...info }
                  : id.startsWith('chat-')
                    ? {
                        type: 2,
                        name: await getGroupName(parseInt(id.slice(5))),
                        ...info
                      }
                    : { type: 3, name: await getUserName(parseInt(id)), ...info }
              )
            )
          ).sort((a, b) => (a.type === b.type ? b.totalSize - a.totalSize : a.type - b.type));

          const groupedStats = stats.reduce(
            (acc, item) => {
              if (!acc[item.type]) acc[item.type] = [];
              acc[item.type].push(item);
              return acc;
            },
            {} as Record<number, typeof stats>
          );

          const lines = [
            '储存总览',
            '总计：',
            ` - 共 ${stats.length} 个表情`,
            ` - 使用 ${stats.reduce((sum, s) => sum + s.totalUses, 0)} 次`,
            ` - 占用 ${formatBytes(stats.reduce((sum, s) => sum + s.totalSize, 0))}`
          ];
          for (const [typeStr, items] of Object.entries(groupedStats)) {
            const type = parseInt(typeStr);
            const label = type === 1 ? '全局' : type === 2 ? '群组' : '用户';
            lines.push('', `${label}：`);
            for (const item of items) {
              lines.push(
                ` - ${item.name ? `${item.name}：` : ''}共 ${item.count} 个, 使用 ${item.totalUses} 次, 占用 ${formatBytes(item.totalSize)}`
              );
            }
          }

          const segments: SendMessageSegment[] = [];
          for (let i = 0; i < lines.length; i += 50) {
            const batch = lines.slice(i, i + 50);
            segments.push({
              type: 'node',
              data: { content: [{ type: 'text', data: { text: batch.join('\n') } }] }
            });
          }

          await send(context, ...segments);
          return;
        }
        if (subcommand === 'list' || (subcommand === 'listall' && isAdmin)) {
          const page = parseInt(segments[2]) || 1;
          const scope =
            segments[3] || (!segments[2] || parseInt(segments[2]) ? 'pcg' : segments[2]);
          const fetchPersonal = scope.includes('p') || scope.includes('私') || scope.includes('自');
          const fetchGroup = scope.includes('c') || scope.includes('群');
          const fetchGlobal = scope.includes('g') || scope.includes('公') || scope.includes('全');
          const images =
            subcommand === 'list'
              ? getImagesByUser(
                  fetchPersonal ? context.user_id.toString() : null,
                  isGroupChat && fetchGroup ? context.group_id.toString() : null,
                  fetchGlobal
                )
              : getAllImages();
          if (images.length === 0) {
            await send(context, {
              type: 'text',
              data: { text: '未查询到任何表情。' }
            });
            return;
          }
          const groups = images.reduce(
            (acc, img) => {
              if (!acc[`${img.name}-${img.user_id}`]) {
                acc[`${img.name}-${img.user_id}`] = [];
              }
              acc[`${img.name}-${img.user_id}`].push(img);
              return acc;
            },
            {} as Record<string, typeof images>
          );
          const groupEntries = Object.entries(groups);
          if (page < 1 || (page - 1) * 50 >= groupEntries.length) {
            await send(context, {
              type: 'text',
              data: { text: `页数超出范围。当前共有 ${Math.ceil(groupEntries.length / 50)} 页。` }
            });
            return;
          }
          await send(context, {
            type: 'node',
            data: {
              content: [
                {
                  type: 'text',
                  data: {
                    text: `已保存的表情列表 (${groupEntries.length}) (第 ${page} 页，共 ${Math.ceil(groupEntries.length / 50)} 页)\n`
                  }
                },
                ...(
                  await Promise.all(
                    groupEntries
                      .slice((page - 1) * 50, page * 50)
                      .map(([id, images]) =>
                        getEmojiList(
                          id.split('-')[0],
                          [random(images)],
                          false,
                          isAdmin && !isGroupChat,
                          isGroupChat ? context.group_id : null,
                          images.length
                        )
                      )
                  )
                ).flat()
              ]
            }
          });
          return;
        }
        const clear = async (userId: string) => {
          const name = segments[2];
          if (!name) {
            await send(context, {
              type: 'text',
              data: { text: `请指定要清除的表情名称。用法：${command} ${subcommand} <名称>` }
            });
            return;
          }
          const images = getImagesByNameAndUser(name, userId);
          const deletedCount = clearImagesByNameAndUserId(name, userId);
          if (deletedCount > 0) {
            images.forEach((img) => {
              deleteEmoji(context, img);
            });
          }
          await send(context, {
            type: 'text',
            data: { text: `成功清除 ${deletedCount} 个表情。` }
          });
        };
        if (subcommand === 'clear' || subcommand === 'cl') {
          await clear(context.user_id.toString());
          return;
        }
        if ((subcommand === 'cleargroup' || subcommand === 'cgr') && isGroupChat) {
          await clear(`chat-${context.group_id}`);
          return;
        }
        if ((subcommand === 'clearglobal' || subcommand === 'cgl') && isAdmin) {
          await clear('global');
          return;
        }
        if (subcommand === 'remove' || subcommand === 'delete' || subcommand === 'rm') {
          const name = segments[2];
          const index = parseInt(segments[3]);
          if (!name) {
            await send(context, {
              type: 'text',
              data: { text: `请指定要删除的表情名称。用法：${command} ${subcommand} <名称> <序号>` }
            });
            return;
          }
          if (isNaN(index) || index < 1) {
            await send(context, {
              type: 'text',
              data: { text: `请指定要删除的表情序号。用法：${command} ${subcommand} <名称> <序号>` }
            });
            return;
          }
          const images = getImagesByNameAndUser(
            name,
            context.user_id.toString(),
            isGroupChat ? context.group_id.toString() : null,
            isAdmin
          );
          if (images.length === 0) {
            await send(context, {
              type: 'text',
              data: { text: `没有找到名称为“${name}”的表情。` }
            });
            return;
          }
          if (index > images.length) {
            await send(context, {
              type: 'text',
              data: { text: `序号超出范围。当前共有 ${images.length} 个表情。` }
            });
            return;
          }
          const imageToDelete = images[index - 1];
          const success = deleteImageById(imageToDelete.id);
          if (success) {
            deleteEmoji(context, imageToDelete);
            await send(context, {
              type: 'text',
              data: { text: `成功删除名称为“${name}”的第 ${index} 个表情。` }
            });
          } else {
            await send(context, {
              type: 'text',
              data: { text: `删除失败，可能是表情不存在。` }
            });
          }
          return;
        }
        if (subcommand === 'transfer' || subcommand === 'mv') {
          const target = segments[2];
          const name = segments[3];
          const index = segments[4] ? parseInt(segments[4]) : undefined;
          if (!name) {
            await send(context, {
              type: 'text',
              data: {
                text: `请指定要转移的个人表情名称。用法：${command} ${subcommand} {group/global} <名称> [序号]`
              }
            });
            return;
          }
          const images = getImagesByNameAndUser(name, context.user_id.toString());
          if (images.length === 0) {
            await send(context, {
              type: 'text',
              data: { text: `没有找到名称为“${name}”的个人表情。` }
            });
            return;
          }
          if (index !== undefined && (isNaN(index) || index < 1 || index > images.length)) {
            await send(context, {
              type: 'text',
              data: {
                text: `序号超出范围。当前共有 ${images.length} 个名称为“${name}”的个人表情。`
              }
            });
            return;
          }
          const imagesToTransfer = index !== undefined ? [images[index - 1]] : images;
          let newUserId: string;
          if (target === 'global') {
            newUserId = 'global';
          } else if (target === 'group') {
            if (!isGroupChat) {
              await send(context, {
                type: 'text',
                data: { text: `只能在群聊中将个人表情转移至群聊层级。` }
              });
              return;
            }
            newUserId = `chat-${context.group_id}`;
          } else {
            await send(context, {
              type: 'text',
              data: {
                text: `请指定目标层级（group 或 global）。用法：${command} ${subcommand} {group/global} <名称> [序号]`
              }
            });
            return;
          }
          const transferredCount = transferImagesOwnership(
            imagesToTransfer.map((img) => img.id),
            newUserId
          );
          await send(context, {
            type: 'text',
            data: {
              text: `成功将 ${transferredCount} 个个人表情转移至${target === 'global' ? '全局' : '群聊'}层级。`
            }
          });
          return;
        }
        const name = subcommand;
        const images = getImagesByNameAndUser(
          name,
          context.user_id.toString(),
          isGroupChat ? context.group_id.toString() : null,
          true
        );
        await send(
          context,
          images.length > 0
            ? {
                type: 'node',
                data: {
                  content: await getEmojiList(
                    name,
                    images,
                    true,
                    isAdmin && !isGroupChat,
                    isGroupChat ? context.group_id : null
                  )
                }
              }
            : {
                type: 'text',
                data: { text: `没有找到名称为“${name}”的表情。` }
              }
        );
        return;
      }
      const save = async (userId: string) => {
        const name = command.slice(1);
        if (!name) {
          return;
        }
        const images = [
          ...context.message,
          ...((
            await (async () => {
              const reply = context.message.find((m) => m.type === 'reply');
              if (!reply) return;
              return await napcat.get_msg({
                message_id: parseInt(reply.data.id)
              });
            })()
          )?.message || [])
        ]
          .filter((m) => m.type === 'image')
          .map((m) => m.data);
        if (!images.length) return;

        try {
          const savedBy = context.user_id.toString();
          const savedFrom = isGroupChat ? context.group_id.toString() : null;

          images.map(async (image) => {
            const filePath = await downloadImage(image.url, userId, image.file);
            insertImage(name, filePath, userId, savedBy, savedFrom);
            console.log(
              `[qmoji] User: ${userId}, Name: ${name}, Path: ${filePath}, SavedBy: ${savedBy}, SavedFrom: ${savedFrom || 'private'}`
            );
          });

          if (isGroupChat) {
            await napcat.set_msg_emoji_like({
              message_id: context.message_id,
              emoji_id: '124'
            });
          } else {
            await send(context, {
              type: 'text',
              data: { text: '保存成功！' }
            });
          }
        } catch (error) {
          console.error('[qmoji] Failed to save image:', error);
          await send(context, {
            type: 'text',
            data: { text: `保存失败：${error instanceof Error ? error.message : '未知错误'}` }
          });
        }
      };
      if (config.prefixes.globalSave.includes(command[0])) {
        await save('global');
      }
      if (config.prefixes.groupSave.includes(command[0]) && isGroupChat) {
        await save(`chat-${context.group_id}`);
      }
      if (config.prefixes.save.includes(command[0])) {
        await save(context.user_id.toString());
      }
      if (config.prefixes.use.includes(command[0])) {
        const name = command.slice(1);
        if (!name) {
          return;
        }
        const images = getImagesByNameAndUser(
          name,
          context.user_id.toString(),
          isGroupChat ? context.group_id.toString() : null,
          true
        );
        if (images.length === 0) {
          if (config.reactOnNotFound) {
            if (isGroupChat) {
              await napcat.set_msg_emoji_like({
                message_id: context.message_id,
                emoji_id: '10068'
              });
            } else {
              await send(context, {
                type: 'text',
                data: { text: `未找到名称为“${name}”的表情。` }
              });
            }
          }
          return;
        }
        const selectedImage = random(images);
        incrementUseCount(selectedImage.id);
        await send(context, await getEmoji(selectedImage, true));
      }
    }
  } catch (err) {
    console.error('[qmoji] Error handling message:', err);
  }
});

await napcat.connect();

let shutdownInitiated = false;
process.on('SIGINT', async () => {
  if (shutdownInitiated) {
    console.log('\nForce exiting...');
    process.exit(1);
  }
  shutdownInitiated = true;
  console.log('\nGracefully shutting down...');

  napcat.disconnect();

  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5000));
  await Promise.race([socketClose.promise, timeout]);

  // Close database connection
  closeDb();

  console.log('Process exited.');
  process.exit(0);
});
