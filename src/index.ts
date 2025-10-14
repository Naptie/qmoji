import { NCWebsocket } from 'node-napcat-ts';
import type { AllHandlers, ImageSegment, SendMessageSegment, TextSegment } from 'node-napcat-ts';
import {
  insertImage,
  closeDb,
  getImagesByUserId,
  getImagesByNameAndUserId,
  type ImageRecord,
  clearImagesByNameAndUserId,
  deleteImageById
} from './db.js';
import { deleteImage, downloadImage, allowlist, allowlistPath, random } from './utils.js';
import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';
import config from '../config.json' with { type: 'json' };

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
  const user = await napcat.get_stranger_info({ user_id: id });
  return user?.nickname ? `${user.nickname} (${id})` : id.toString();
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
  showIndex = false
): Promise<SendMessageSegment[]> => [
  { type: 'text', data: { text: `「${name}」(共 ${images.length} 个)\n` } },
  ...(
    await Promise.all(
      images.map(async (img, i) => {
        const imgSegment = await getEmoji(img);
        return showIndex
          ? [
              {
                type: 'text',
                data: { text: `${i + 1}.\n` }
              } satisfies TextSegment,
              imgSegment
            ]
          : [imgSegment];
      })
    )
  ).flat()
];

const deleteEmoji = (context: AllHandlers['message'], image: ImageRecord) => {
  const userImages = getImagesByUserId(context.user_id.toString());
  if (!userImages.find((img) => img.file_path === image.file_path)) {
    deleteImage(image.file_path);
  }
};

const sendMsg = async (context: AllHandlers['message'], ...segments: SendMessageSegment[]) => {
  if ('group_id' in context) {
    await napcat.send_msg({
      group_id: context.group_id,
      message: segments
    });
  } else {
    await napcat.send_msg({
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
    if (allowlist && !allowlist.includes(context.user_id)) {
      return;
    }
    const message = context.message.find((m) => m.type === 'text');
    if (message) {
      const command = message.data.text;
      const segments = command
        .split(/\s+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      if (!segments.length) return;
      if (config.prefixes.utils.includes(segments[0])) {
        const prefix = segments[0];
        const subcommand = segments[1] || '';
        if (subcommand === 'allowlist' && config.admins?.includes(context.user_id)) {
          const operation = segments[2] || '';
          if (!operation) {
            if (!allowlist || allowlist.length === 0) {
              await sendMsg(context, {
                type: 'text',
                data: { text: '当前允许名单为空，任何人均可使用指令。' }
              });
              return;
            }
            await sendMsg(context, {
              type: 'text',
              data: {
                text: `当前允许名单：\n${(await Promise.all(allowlist.map(async (id) => `- ${await getUserName(id)}`))).join('\n')}`
              }
            });
            return;
          }
          if (operation !== 'add' && operation !== 'remove') {
            await sendMsg(context, {
              type: 'text',
              data: {
                text: `用法：${prefix} ${subcommand} [add|remove]`
              }
            });
            return;
          }
          const mention = context.message.find((m) => m.type === 'at');
          if (!mention) {
            await sendMsg(context, {
              type: 'text',
              data: {
                text: `请提及需要操作的用户。用法：${prefix} ${subcommand} ${operation} @用户`
              }
            });
            return;
          }
          const targetId = parseInt(mention.data.qq);
          const target = await getUserName(targetId);
          if (isNaN(targetId)) {
            await sendMsg(context, {
              type: 'text',
              data: { text: `无法识别提及的用户。` }
            });
            return;
          }
          if (operation === 'add') {
            if (allowlist.includes(targetId)) {
              await sendMsg(context, {
                type: 'text',
                data: { text: `用户 ${target} 已在允许名单中。` }
              });
              return;
            }
            allowlist.push(targetId);
            await sendMsg(context, {
              type: 'text',
              data: { text: `已将用户 ${target} 添加到允许名单。` }
            });
          } else if (operation === 'remove') {
            if (!allowlist || !allowlist.includes(targetId)) {
              await sendMsg(context, {
                type: 'text',
                data: { text: `用户 ${target} 不在允许名单中。` }
              });
              return;
            }
            allowlist.splice(allowlist.indexOf(targetId), 1);
            await sendMsg(context, {
              type: 'text',
              data: { text: `已将用户 ${target} 从允许名单中移除。` }
            });
          }
          await writeFile(allowlistPath, JSON.stringify(allowlist), 'utf-8');
          console.log(`[qmoji] Updated allowlist: ${allowlist}`);
          return;
        }
        if (subcommand === 'list') {
          const images = getImagesByUserId(context.user_id.toString());
          if (images.length === 0) {
            await sendMsg(context, {
              type: 'text',
              data: { text: '你还没有保存任何表情。' }
            });
            return;
          }
          const groups = images.reduce(
            (acc, img) => {
              if (!acc[img.name]) {
                acc[img.name] = [];
              }
              acc[img.name].push(img);
              return acc;
            },
            {} as Record<string, typeof images>
          );
          await sendMsg(context, {
            type: 'node',
            data: {
              content: (
                await Promise.all(
                  Object.entries(groups).map(([name, images]) =>
                    getEmojiList(name, [random(images)])
                  )
                )
              ).flat()
            }
          });
          return;
        }
        if (subcommand === 'clear') {
          const name = segments[2];
          if (!name) {
            await sendMsg(context, {
              type: 'text',
              data: { text: `请指定要清除的表情名称。用法：${prefix} ${subcommand} <名称>` }
            });
            return;
          }
          const images = getImagesByNameAndUserId(name, context.user_id.toString());
          const deletedCount = clearImagesByNameAndUserId(name, context.user_id.toString());
          if (deletedCount > 0) {
            images.forEach((img) => {
              deleteEmoji(context, img);
            });
          }
          await sendMsg(context, {
            type: 'text',
            data: { text: `成功清除 ${deletedCount} 个表情。` }
          });
          return;
        }
        if (subcommand === 'remove' || subcommand === 'delete') {
          const name = segments[2];
          const index = parseInt(segments[3]);
          if (!name) {
            await sendMsg(context, {
              type: 'text',
              data: { text: `请指定要删除的表情名称。用法：${prefix} ${subcommand} <名称> <序号>` }
            });
            return;
          }
          if (isNaN(index) || index < 1) {
            await sendMsg(context, {
              type: 'text',
              data: { text: `请指定要删除的表情序号。用法：${prefix} ${subcommand} <名称> <序号>` }
            });
            return;
          }
          const images = getImagesByNameAndUserId(name, context.user_id.toString());
          if (images.length === 0) {
            await sendMsg(context, {
              type: 'text',
              data: { text: `没有找到名称为“${name}”的表情。` }
            });
            return;
          }
          if (index > images.length) {
            await sendMsg(context, {
              type: 'text',
              data: { text: `序号超出范围。当前共有 ${images.length} 个表情。` }
            });
            return;
          }
          const imageToDelete = images[index - 1];
          const success = deleteImageById(imageToDelete.id);
          if (success) {
            deleteEmoji(context, imageToDelete);
            await sendMsg(context, {
              type: 'text',
              data: { text: `成功删除名称为“${name}”的第 ${index} 个表情。` }
            });
          } else {
            await sendMsg(context, {
              type: 'text',
              data: { text: `删除失败，可能是表情不存在。` }
            });
          }
          return;
        }
        const name = segments[1];
        if (name) {
          const images = getImagesByNameAndUserId(name, context.user_id.toString());
          await sendMsg(
            context,
            images.length > 0
              ? {
                  type: 'node',
                  data: {
                    content: await getEmojiList(name, images, true)
                  }
                }
              : {
                  type: 'text',
                  data: { text: `没有找到名称为“${name}”的表情。` }
                }
          );
          return;
        }
      }
      if (config.prefixes.save.includes(segments[0][0])) {
        const name = segments[0].slice(1);
        const reply = context.message.find((m) => m.type === 'reply');
        if (!reply) return;
        const replyMsg = await napcat.get_msg({
          message_id: parseInt(reply.data.id)
        });
        const image = replyMsg.message.find((m) => m.type === 'image')?.data;
        if (!image) return;

        try {
          // Download and save the image
          const userId = context.user_id.toString();
          const filePath = await downloadImage(image.url, userId, image.file);

          // Save to database
          insertImage(name, filePath, userId);

          console.log(`[qmoji] User: ${userId}, Name: ${name}, Path: ${filePath}`);

          await napcat.set_msg_emoji_like({
            message_id: context.message_id,
            emoji_id: '124'
          });
        } catch (error) {
          console.error('[qmoji] Failed to save image:', error);
          await sendMsg(context, {
            type: 'text',
            data: { text: `保存失败：${error instanceof Error ? error.message : '未知错误'}` }
          });
        }
      }
      if (config.prefixes.use.includes(segments[0][0])) {
        const name = segments[0].slice(1);
        const images = getImagesByNameAndUserId(name, context.user_id.toString());
        if (images.length === 0) {
          if (config.reactOnNotFound) {
            await napcat.set_msg_emoji_like({
              message_id: context.message_id,
              emoji_id: '10068'
            });
          }
          return;
        }
        await sendMsg(context, await getEmoji(random(images), true));
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
