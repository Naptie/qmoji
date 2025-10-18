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
import {
  createPolicyManager,
  type PolicyRule,
  type PermissionScope,
  type PermissionAction,
  type PolicySelector
} from './policy.js';

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

const defaultPolicyRules: PolicyRule[] = [
  {
    id: 'default-global-everyone',
    scope: 'global',
    selector: { type: 'everyone' },
    permissions: { read: true, create: true, remove: false },
    priority: 0,
    createdAt: 0
  },
  {
    id: 'default-group-everyone',
    scope: 'group',
    selector: { type: 'everyone' },
    permissions: { read: true, create: true, remove: true },
    priority: 0,
    createdAt: 0
  },
  {
    id: 'default-personal-everyone',
    scope: 'personal',
    selector: { type: 'everyone' },
    permissions: { read: true, create: true, remove: true },
    priority: 0,
    createdAt: 0
  }
];

const policyManager = createPolicyManager({
  filePath: resolve(process.cwd(), 'policy.json'),
  defaultRules: defaultPolicyRules
});

const groupAdminCache = new Map<string, { expires: number; value: boolean }>();

const getGroupAdminStatus = async (userId: number, groupId: number) => {
  const key = `${groupId}:${userId}`;
  const cached = groupAdminCache.get(key);
  const now = Date.now();
  if (cached && cached.expires > now) {
    return cached.value;
  }
  try {
    const info = await napcat.get_group_member_info({ group_id: groupId, user_id: userId });
    const isAdmin = info?.role === 'owner' || info?.role === 'admin';
    groupAdminCache.set(key, { value: Boolean(isAdmin), expires: now + 60_000 });
    return Boolean(isAdmin);
  } catch (err) {
    console.error('[qmoji] Failed to fetch group member info:', err);
    groupAdminCache.set(key, { value: false, expires: now + 15_000 });
    return false;
  }
};

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
  count?: number,
  page?: number,
  pageSize = 20
): Promise<SendMessageSegment[]> => {
  const totalUses = images.reduce((sum, img) => sum + img.use_count, 0);
  let saveInfo = '';
  const imagesToShow =
    page !== undefined ? images.slice((page - 1) * pageSize, page * pageSize) : images;
  const segments = (
    await Promise.all(
      imagesToShow.map(async (img, i) => {
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
                  text: `${(page ? (page - 1) * pageSize : 0) + i + 1}.${ownershipLabel}${useCountInfo}${savedByInfo}${savedFromInfo}\n`
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
        text:
          `「${name}」(${images.every((i) => i.user_id === 'global') ? '全局, ' : images.every((i) => i.user_id.startsWith('chat-')) ? '群聊, ' : ''}共 ${count !== undefined ? count : images.length} 个, 使用 ${totalUses} 次)` +
          (page ? ` (第 ${page} 页, 共 ${Math.ceil(images.length / pageSize)} 页)` : '') +
          (saveInfo ? `\n${saveInfo}` : '') +
          `\n`
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
    const currentGroupId = 'group_id' in context ? context.group_id : undefined;
    const isGroupChat = currentGroupId !== undefined;
    if (
      !allowlist.users?.includes(context.user_id) &&
      (currentGroupId === undefined || !allowlist.groups?.includes(currentGroupId))
    ) {
      return;
    }
    const rawSegments: string[] = [];
    for (const segment of context.message) {
      if (segment.type === 'text') {
        rawSegments.push(...segment.data.text.split(/\s+/));
      } else if (segment.type === 'at' && segment.data?.qq) {
        rawSegments.push(`@${segment.data.qq}`);
      }
    }
    const segments = rawSegments
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (!segments.length) {
      return;
    }

    const command = segments[0];
    if (command && [...command].every((char) => char === command[0])) {
      return;
    }
    const isAdmin = config.admins?.includes(context.user_id);

    const mentionUserIds = context.message.reduce<string[]>((ids, segment) => {
        if (segment.type === 'at' && segment.data?.qq) {
          ids.push(segment.data.qq);
        }
        return ids;
      }, []);

      const actorContext = {
        userId: context.user_id,
        groupId: currentGroupId,
        isAdmin: Boolean(isAdmin),
        isAllowlistUser: Boolean(allowlist.users?.includes(context.user_id)),
        isAllowlistGroup: currentGroupId ? Boolean(allowlist.groups?.includes(currentGroupId)) : false,
        isGroupAdmin: async (groupId: string) => {
          const numericId = Number(groupId);
          if (Number.isNaN(numericId)) {
            return false;
          }
          return await getGroupAdminStatus(context.user_id, numericId);
        }
      };

      const buildTarget = (
        scope: PermissionScope,
        options: { ownerId?: string; groupId?: string } = {}
      ) => ({
        scope,
        ...(options.ownerId ? { ownerId: options.ownerId } : {}),
        ...(options.groupId ? { groupId: options.groupId } : {})
      });

      const resolveImageTarget = (image: ImageRecord) => {
        if (image.user_id === 'global') {
          return buildTarget('global');
        }
        if (image.user_id.startsWith('chat-')) {
          return buildTarget('group', { groupId: image.user_id.slice(5) });
        }
        return buildTarget('personal', { ownerId: image.user_id });
      };

      const resolveUserTarget = (userId: string) => {
        if (userId === 'global') {
          return buildTarget('global');
        }
        if (userId.startsWith('chat-')) {
          return buildTarget('group', { groupId: userId.slice(5) });
        }
        return buildTarget('personal', { ownerId: userId });
      };

      const canAccess = async (
        target: ReturnType<typeof buildTarget>,
        action: PermissionAction
      ) => {
        if (!config.enablePolicyAuth) {
          return true;
        }
        return await policyManager.isAllowed(actorContext, target, action);
      };

      const ensurePermission = async (
        target: ReturnType<typeof buildTarget>,
        action: PermissionAction,
        failureMessage = '无权限执行此操作。'
      ) => {
        const allowed = await canAccess(target, action);
        if (!allowed) {
          await send(context, {
            type: 'text',
            data: { text: failureMessage }
          });
        }
        return allowed;
      };

      const filterImagesByAction = async (images: ImageRecord[], action: PermissionAction) => {
        if (!config.enablePolicyAuth) {
          return images;
        }
        const results: ImageRecord[] = [];
        for (const image of images) {
          if (await canAccess(resolveImageTarget(image), action)) {
            results.push(image);
          }
        }
        return results;
      };

      const scopeLabels: Record<PermissionScope, string> = {
        global: '全局',
        group: '群聊',
        personal: '个人'
      };

      const actionLabels: Record<PermissionAction, string> = {
        read: '读取',
        create: '保存',
        remove: '删除'
      };

      const permissionsToIcons = (permissions: Record<PermissionAction, boolean>) =>
        `${permissions.read ? '✅' : '❌'}读取 ${permissions.create ? '✅' : '❌'}保存 ${permissions.remove ? '✅' : '❌'}删除`;

      const bitsToPermissions = (bits: string) => {
        if (!/^[01]{3}$/.test(bits)) {
          return { error: '权限格式须为三个 0/1 组成，依次代表读取/保存/删除。' } as const;
        }
        return {
          permissions: {
            read: bits[0] === '1',
            create: bits[1] === '1',
            remove: bits[2] === '1'
          }
        } as const;
      };

      const describeSelector = (selector: PolicySelector) => {
        switch (selector.type) {
          case 'admin':
            return '管理员';
          case 'allowlist_user':
          case 'everyone':
            return '所有可用用户';
          case 'group':
            return selector.value ? `群 ${selector.value}` : '所有群';
          case 'groupadmin':
            return selector.value ? `群 ${selector.value} 的群管` : '所有群的群管';
          case 'group_member':
            return '群成员';
          case 'owner':
            return '拥有者';
          case 'user':
            return `用户 ${selector.value}`;
          default:
            return selector.type;
        }
      };

      const numericRegexp = /^-?\d+$/;

      const parsePriority = (token?: string) => {
        if (!token) {
          return { value: 0, consumed: false } as const;
        }
        if (!numericRegexp.test(token)) {
          return { value: 0, consumed: false } as const;
        }
        return { value: parseInt(token, 10), consumed: true } as const;
      };

      const parseScope = (token: string | undefined): PermissionScope | null => {
        if (!token) return null;
        const lower = token.toLowerCase();
        if (['global', 'g', 'all', 'public'].includes(lower)) return 'global';
        if (['group', 'c', 'chat', 'channel', 'guild'].includes(lower)) return 'group';
        if (['personal', 'p', 'user', 'private', 'person', 'self'].includes(lower)) return 'personal';
        return null;
      };

      const actionMap: Record<string, PermissionAction> = {
        read: 'read',
        view: 'read',
        r: 'read',
        v: 'read',
        create: 'create',
        save: 'create',
        write: 'create',
        c: 'create',
        w: 'create',
        s: 'create',
        remove: 'remove',
        delete: 'remove',
        del: 'remove',
        d: 'remove',
        rm: 'remove'
      };

      const parseSelectorToken = (
        token: string | undefined,
        scope: PermissionScope,
        mentionUserList: string[]
      ): { selector?: PolicySelector; error?: string } => {
        const ensureGroupValue = (raw?: string) => {
          let value = raw;
          if (!value) {
            if (!currentGroupId) {
              return { error: '请提供群号，或在群聊中使用该指令。' } as const;
            }
            value = currentGroupId.toString();
          }
          if (!numericRegexp.test(value)) {
            return { error: '群号必须为数字。' } as const;
          }
          return { value } as const;
        };

        const ensureUserValue = (raw?: string) => {
          let value = raw;
          if (!value && mentionUserList.length) {
            value = mentionUserList[0];
          }
          if (!value) {
            return { error: '请提供用户 QQ 号，或通过 @ 指定用户。' } as const;
          }
          if (!numericRegexp.test(value)) {
            return { error: '用户 QQ 号必须为数字。' } as const;
          }
          return { value } as const;
        };

        if (!token || token === '-') {
          if (scope === 'group') {
            const result = ensureGroupValue();
            if ('error' in result) return result;
            return { selector: { type: 'group', value: result.value } };
          }
          if (scope === 'personal') {
            return { selector: { type: 'user', value: context.user_id.toString() } };
          }
          return { selector: { type: 'everyone' } };
        }

        if (token.startsWith('@')) {
          const possibleId = token.slice(1);
          if (!possibleId) {
            return { error: '请提供用户 QQ 号，或通过 @ 指定用户。' };
          }
          if (!numericRegexp.test(possibleId)) {
            return { error: '用户 QQ 号必须为数字。' };
          }
          return { selector: { type: 'user', value: possibleId } };
        }

        const [rawType, rawValue] = token.split(':', 2);
        let type = rawType.toLowerCase();
        const value = rawValue;

        if (type === 'group_admin') type = 'groupadmin';
        if (type === 'groupmember') type = 'group_member';

        switch (type) {
          case 'allowlist_user':
          case 'everyone':
            return { selector: { type: 'everyone' } };
          case 'admin':
            return { selector: { type: 'admin' } };
          case '群':
          case 'chat':
          case 'channel':
          case 'guild':
          case 'g':
          case 'group': {
            const result = ensureGroupValue(value);
            if ('error' in result) return result;
            return { selector: { type: 'group', value: result.value } };
          }
          case 'groupadmin': {
            const result = ensureGroupValue(value);
            if ('error' in result) return result;
            return { selector: { type: 'groupadmin', value: result.value } };
          }
          case 'group_member': {
            const result = ensureGroupValue(value);
            if ('error' in result) return result;
            return { selector: { type: 'group_member', value: result.value } };
          }
          case 'owner':
            return { selector: { type: 'owner' } };
          case 'u':
          case 'user': {
            const result = ensureUserValue(value);
            if ('error' in result) return result;
            return { selector: { type: 'user', value: result.value } };
          }
          default:
            return { error: `未知的选择器，可选：group:<群号>、user:<用户QQ号>、group_admin、group_member、owner、everyone` };
        }
      };

      const ensureCanModifyPolicies = async (scope: PermissionScope, selector: PolicySelector) => {
        if (isAdmin) {
          return true;
        }
        if (scope === 'group') {
          const targetGroupId = selector.value;
          if (!targetGroupId) {
            await send(context, {
              type: 'text',
              data: { text: '无法确定目标群号，无法修改权限。' }
            });
            return false;
          }
          if (!currentGroupId || targetGroupId !== currentGroupId.toString()) {
            await send(context, {
              type: 'text',
              data: { text: '只能在目标群内由群主或管理员执行该操作。' }
            });
            return false;
          }
          const isGroupAdmin = await getGroupAdminStatus(context.user_id, currentGroupId);
          if (!isGroupAdmin) {
            await send(context, {
              type: 'text',
              data: { text: '需要群主或管理员权限才能修改本群的规则。' }
            });
            return false;
          }
          return true;
        }
        await send(context, {
          type: 'text',
          data: { text: '只有全局管理员可以修改该范围的权限。' }
        });
        return false;
      };

      const summarizeRule = (rule: PolicyRule) =>
        `${describeSelector(rule.selector)}对于${scopeLabels[rule.scope]}：${permissionsToIcons(rule.permissions)} · 优先级 ${rule.priority}`;

      const handlePermissionToggle = async (enable: boolean, args: string[]) => {
        if (!config.enablePolicyAuth) {
          await send(context, {
            type: 'text',
            data: { text: '当前未启用权限系统。' }
          });
          return;
        }
        const tokens = [...args];
        let priorityValue: number | undefined;
        if (tokens.length) {
          const maybePriority = tokens[tokens.length - 1];
          const pr = parsePriority(maybePriority);
          if (pr.consumed) {
            priorityValue = pr.value;
            tokens.pop();
          }
        }
        if (tokens.length < 2) {
          await send(context, {
            type: 'text',
            data: {
              text:
                `用法：${command} ${enable ? 'enable' : 'disable'} [selector|-] <action> <scope> [priority]\n` +
                '示例：qmoji1 enable user:123 view global'
            }
          });
          return;
        }
        let selectorToken: string | undefined;
        if (tokens.length >= 3) {
          selectorToken = tokens.shift();
        }
        const actionToken = tokens.shift();
        const scopeToken = tokens.shift();
        if (!actionToken || !scopeToken || tokens.length) {
          await send(context, {
            type: 'text',
            data: { text: '请按照 <选择器> <动作> <范围> [优先级] 的格式提供参数。' }
          });
          return;
        }
        const action = actionMap[actionToken.toLowerCase()];
        if (!action) {
          await send(context, {
            type: 'text',
            data: { text: '未知的动作，可选：read/view/v/r、create/write/w/s/save、remove/delete/del/d。' }
          });
          return;
        }
        const scope = parseScope(scopeToken);
        if (!scope) {
          await send(context, {
            type: 'text',
            data: { text: '未知的范围，可选：global/g/all、公/全；group/c/chat/群；personal/p/self/私/自。' }
          });
          return;
        }
        const selectorResult = parseSelectorToken(selectorToken, scope, mentionUserIds);
        if (selectorResult.error || !selectorResult.selector) {
          await send(context, {
            type: 'text',
            data: { text: selectorResult.error ?? '未能解析目标。' }
          });
          return;
        }
        const selector = selectorResult.selector;
        if (!(await ensureCanModifyPolicies(scope, selector))) {
          return;
        }
        const { rule, created } = policyManager.updateSinglePermission(
          scope,
          selector,
          priorityValue,
          action,
          enable
        );
        await send(context, {
          type: 'text',
          data: {
            text:
              `${enable ? '已允许' : '已禁止'}${describeSelector(selector)}对${scopeLabels[scope]}的${actionLabels[action]}权限。\n` +
              `${created ? '新增规则' : '更新规则'}：${permissionsToIcons(rule.permissions)}（优先级 ${rule.priority}）。`
          }
        });
      };

      const handlePermCommand = async (args: string[]) => {
        if (!config.enablePolicyAuth) {
          await send(context, {
            type: 'text',
            data: { text: '当前未启用权限系统。' }
          });
          return;
        }
        const action = args[0] || 'help';
        if (action === 'help') {
          await send(context, {
            type: 'text',
            data: {
              text:
                '权限指令：\n' +
                '· qmoji1 perm [view|list|ls|l] [global|group|personal] [--all] - 查看规则\n' +
                '· qmoji1 perm status [global|group|personal] - 查看当前权限\n' +
                '· qmoji1 perm set <范围> <选择器> <权限串> [优先级] - 设置自定义权限\n' +
                '· qmoji1 perm clear <范围> [选择器] [优先级] [--all] - 移除规则\n' +
                '· qmoji1 enable/disable <选择器> <动作> <范围> [优先级] - 快速单项开关'
            }
          });
          return;
        }

        if (action === 'view' || action === 'list' || action === 'ls' || action === 'l') {
          const tokens = args.slice(1);
          let filterScope: PermissionScope | null = null;
          let showDefaults = false;
          for (const token of tokens) {
            if (token === '--all') {
              showDefaults = true;
              continue;
            }
            const scope = parseScope(token);
            if (scope) {
              filterScope = scope;
            }
          }
          if (showDefaults && !isAdmin) {
            showDefaults = false;
          }
          const { custom, defaults } = policyManager.listRules();
          const scopesOrder: PermissionScope[] = ['global', 'group', 'personal'];
          const lines: string[] = [];
          for (const scope of scopesOrder) {
            if (filterScope && scope !== filterScope) continue;
            const rules = custom.filter((rule) => rule.scope === scope);
            lines.push(`${scopeLabels[scope]}：`);
            if (!rules.length) {
              lines.push(' - 无自定义规则');
            } else {
              rules.forEach((rule, idx) => {
                lines.push(` ${idx + 1}. ${summarizeRule(rule)}`);
              });
            }
            lines.push('');
          }
          if (showDefaults) {
            lines.push('默认规则：');
            defaults.forEach((rule, idx) => {
              lines.push(` ${idx + 1}. ${summarizeRule(rule)}`);
            });
          }
          const payload: SendMessageSegment[] = [];
          for (let i = 0; i < lines.length; i += 50) {
            const batch = lines.slice(i, i + 50);
            payload.push({
              type: 'node',
              data: { content: [{ type: 'text', data: { text: batch.join('\n') } }] }
            });
          }
          await send(context, ...payload);
          return;
        }

        if (action === 'status') {
          const scopeToken = args[1];
          const scopes: PermissionScope[] = scopeToken
            ? (() => {
                const scope = parseScope(scopeToken);
                return scope ? [scope] : [];
              })()
            : (['global', 'group', 'personal'] as PermissionScope[]);
          if (!scopes.length) {
            await send(context, {
              type: 'text',
              data: { text: '未知的范围，可选：global/group/personal。' }
            });
            return;
          }
          const lines = ['你的权限：'];
          for (const scope of scopes) {
            if (scope === 'group' && !isGroupChat) {
              lines.push('群聊：请在群聊中使用该指令查看群聊权限。');
              continue;
            }
            const target =
              scope === 'global'
                ? buildTarget('global')
                : scope === 'group'
                  ? buildTarget('group', { groupId: currentGroupId!.toString() })
                  : buildTarget('personal', { ownerId: context.user_id.toString() });
            const status = {
              read: await canAccess(target, 'read'),
              create: await canAccess(target, 'create'),
              remove: await canAccess(target, 'remove')
            };
            lines.push(`${scopeLabels[scope]}：${permissionsToIcons(status)}`);
          }
          await send(context, {
            type: 'text',
            data: { text: lines.join('\n') }
          });
          return;
        }


        if (action === 'set') {
          if (args.length < 4) {
            await send(context, {
              type: 'text',
              data: { text: '用法：qmoji1 perm set <scope> <selector> <权限串> [priority]' }
            });
            return;
          }
          const scope = parseScope(args[1]);
          if (!scope) {
            await send(context, {
              type: 'text',
              data: { text: '未知的范围，可选：global/group/personal。' }
            });
            return;
          }
          const permsResult = bitsToPermissions(args[3]);
          if (permsResult.error || !permsResult.permissions) {
            await send(context, {
              type: 'text',
              data: { text: permsResult.error ?? '权限格式不正确。' }
            });
            return;
          }
          const extras = [...args.slice(4)];
          let priority = 0;
          let priorityProvided = false;
          if (extras.length) {
            const pr = parsePriority(extras[extras.length - 1]);
            if (pr.consumed) {
              priority = pr.value;
              priorityProvided = true;
              extras.pop();
            }
          }
          const selectorResult = parseSelectorToken(args[2], scope, mentionUserIds);
          if (selectorResult.error || !selectorResult.selector) {
            await send(context, {
              type: 'text',
              data: { text: selectorResult.error ?? '未能解析目标。' }
            });
            return;
          }
          const selector = selectorResult.selector;
          if (!(await ensureCanModifyPolicies(scope, selector))) {
            return;
          }
          const { rule, created } = policyManager.setRulePermissions(
            scope,
            selector,
            priorityProvided ? priority : undefined,
            permsResult.permissions
          );
          await send(context, {
            type: 'text',
            data: {
              text:
                `${created ? '已新增规则' : '已更新规则'}：${summarizeRule(rule)}\n` +
                `新的权限：${permissionsToIcons(rule.permissions)}（优先级 ${rule.priority}）。`
            }
          });
          return;
        }

        if (action === 'clear') {
          if (args.length < 2) {
            await send(context, {
              type: 'text',
              data: { text: '用法：qmoji1 perm clear <scope> [selector] [priority]' }
            });
            return;
          }
          const scope = parseScope(args[1]);
          if (!scope) {
            await send(context, {
              type: 'text',
              data: { text: '未知的范围，可选：global/group/personal。' }
            });
            return;
          }
          const extras = [...args.slice(2)];
          const removeAll = true;
          // if (extras.length && extras[extras.length - 1] === '--all') {
          //   removeAll = true;
          //   extras.pop();
          // }
          let priority = 0;
          let priorityProvided = false;
          if (extras.length) {
            const pr = parsePriority(extras[extras.length - 1]);
            if (pr.consumed) {
              priority = pr.value;
              priorityProvided = true;
              extras.pop();
            }
          }
          const selectorResult = parseSelectorToken(extras[0], scope, mentionUserIds);
          if (selectorResult.error || !selectorResult.selector) {
            await send(context, {
              type: 'text',
              data: { text: selectorResult.error ?? '未能解析目标。' }
            });
            return;
          }
          const selector = selectorResult.selector;
          if (!(await ensureCanModifyPolicies(scope, selector))) {
            return;
          }
          const removed = policyManager.removeRules(
            scope,
            selector,
            priorityProvided ? priority : undefined,
            removeAll
          );
          if (!removed.length) {
            await send(context, {
              type: 'text',
              data: { text: '未找到匹配的自定义规则。' }
            });
            return;
          }
          const lines = removed.map((rule, idx) => `${idx + 1}. ${summarizeRule(rule)}`);
          await send(context, {
            type: 'text',
            data: {
              text:
                `已移除 ${removed.length} 条规则：\n` +
                lines.join('\n')
            }
          });
          return;
        }

        await send(context, {
          type: 'text',
          data: { text: '未知的 perm 子命令，可使用 qmoji1 perm help 查看帮助。' }
        });
      };
      if (config.prefixes.utils.includes(command)) {
        const subcommand = segments[1] || '';
        if (subcommand === 'perm') {
          await handlePermCommand(segments.slice(2));
          return;
        }
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
                `${command} <名称> [页数] - 列出指定名称的所有表情\n` +
                `保存个人表情：在回复的消息中使用 ${config.prefixes.save[0]}<名称> 进行保存\n` +
                `保存群聊表情：在回复的消息中使用 ${config.prefixes.groupSave[0]}<名称> 进行保存\n` +
                `保存全局表情：在回复的消息中使用 ${config.prefixes.globalSave[0]}<名称> 进行保存\n` +
                `使用表情：在消息中使用 ${config.prefixes.use[0]}<名称> 进行发送`
            }
          });
          return;
        }
        if (subcommand === 'enable' || subcommand === 'disable') {
          const argsForToggle = segments.slice(2);
          if (argsForToggle.length) {
            await handlePermissionToggle(subcommand === 'enable', argsForToggle);
            return;
          }
          if (!isGroupChat || currentGroupId === undefined) {
            await send(context, {
              type: 'text',
              data: { text: '仅能在群聊中使用该命令以调整群允许名单。' }
            });
            return;
          }
          const isEnable = subcommand === 'enable';
          const exists = allowlist.groups?.includes(currentGroupId);
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
            allowlist.groups.push(currentGroupId);
            await send(context, {
              type: 'text',
              data: { text: `已将本群添加到允许名单。` }
            });
          } else {
            allowlist.groups = allowlist.groups.filter((id) => id !== currentGroupId);
            await send(context, {
              type: 'text',
              data: { text: `已将本群从允许名单中移除。` }
            });
          }
          await writeFile(allowlistPath, JSON.stringify(allowlist), 'utf-8');
          console.log(`[qmoji] Updated group allowlist: ${await getGroupName(currentGroupId)}`);
          return;
        }
        if (subcommand === 'allowlist' && isAdmin) {
          const operation = segments[2] || '';
          if (!operation) {
            await send(context, {
              type: 'text',
              data: {
                text:
                  'qmoji1 允许名单\n' +
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
          const normalizedScope = scope.toLowerCase();
          const letterMode = /^[pcg/]+$/.test(normalizedScope);
          const letterFlags = letterMode
            ? new Set(normalizedScope.replace(/\//g, '').split(''))
            : new Set<string>();
          const scopeWords = scope
            .toLowerCase()
            .replace(/[/,]+/g, ' ')
            .split(/\s+/)
            .filter(Boolean);
          const includesFlag = (letters: string[], words: string[], chars: string[]) =>
            (letterMode && letters.some((l) => letterFlags.has(l))) ||
            scopeWords.some((word) => words.includes(word)) ||
            chars.some((char) => scope.includes(char));
          const fetchPersonal = includesFlag(
            ['p'],
            ['p', 'personal', 'person', 'private', 'self', 'user'],
            ['私', '自']
          );
          const fetchGroup = includesFlag(
            ['c'],
            ['c', 'group', 'chat', 'channel', 'guild'],
            ['群']
          );
          const fetchGlobal = includesFlag(
            ['g'],
            ['g', 'global', 'all', 'public'],
            ['公', '全']
          );
          const rawImages =
            subcommand === 'list'
              ? getImagesByUser(
                  fetchPersonal ? context.user_id.toString() : null,
                  isGroupChat && fetchGroup && currentGroupId !== undefined
                    ? currentGroupId.toString()
                    : null,
                  fetchGlobal
                )
              : getAllImages();
          const images = await filterImagesByAction(rawImages, 'read');
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
                          isGroupChat && currentGroupId !== undefined ? currentGroupId : null,
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
          const targetForClear = resolveUserTarget(userId);
          if (!(await ensurePermission(targetForClear, 'remove', '无权限清除该层级的表情。'))) {
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
          if (currentGroupId === undefined) {
            await send(context, {
              type: 'text',
              data: { text: '无法识别当前群号，无法清除群聊表情。' }
            });
            return;
          }
          await clear(`chat-${currentGroupId}`);
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
            isGroupChat && currentGroupId !== undefined ? currentGroupId.toString() : null,
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
          if (!(await ensurePermission(resolveImageTarget(imageToDelete), 'remove', '无权限删除该表情。'))) {
            return;
          }
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
          for (const image of imagesToTransfer) {
            if (!(await ensurePermission(resolveImageTarget(image), 'remove', '无权限转移该表情。'))) {
              return;
            }
          }
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
            if (currentGroupId === undefined) {
              await send(context, {
                type: 'text',
                data: { text: `无法识别当前群号，请稍后再试。` }
              });
              return;
            }
            newUserId = `chat-${currentGroupId}`;
          } else {
            await send(context, {
              type: 'text',
              data: {
                text: `请指定目标层级（group 或 global）。用法：${command} ${subcommand} {group/global} <名称> [序号]`
              }
            });
            return;
          }
          const targetForTransfer = resolveUserTarget(newUserId);
          if (!(await ensurePermission(targetForTransfer, 'create', '无权限保存到目标层级。'))) {
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
        const page = Number.parseInt(segments[2] ?? '', 10) || 1;
        const pageSize = 20;
        const images = await filterImagesByAction(
          getImagesByNameAndUser(
            name,
            context.user_id.toString(),
            isGroupChat && currentGroupId !== undefined ? currentGroupId.toString() : null,
            true
          ),
          'read'
        );
        if (!images.length) {
          await send(context, {
            type: 'text',
            data: { text: `没有找到名称为“${name}”的表情。` }
          });
          return;
        }
        if (page < 1 || (page - 1) * pageSize >= images.length) {
          await send(context, {
            type: 'text',
            data: { text: `页数超出范围。当前共有 ${Math.ceil(images.length / pageSize)} 页。` }
          });
          return;
        }
        await send(context, {
          type: 'node',
          data: {
            content: await getEmojiList(
              name,
              images,
              true,
              isAdmin && !isGroupChat,
              isGroupChat && currentGroupId !== undefined ? currentGroupId : null,
              images.length,
              page,
              pageSize
            )
          }
        });
        return;
      }
      const save = async (userId: string) => {
        const name = command.slice(1);
        if (!name) {
          return;
        }
        const targetForSave = resolveUserTarget(userId);
        if (!(await ensurePermission(targetForSave, 'create', '无权限保存到该层级。'))) {
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
          const savedFrom = isGroupChat && currentGroupId !== undefined ? currentGroupId.toString() : null;

          await Promise.all(
            images.map(async (image) => {
              const filePath = await downloadImage(image.url, userId, image.file);
              insertImage(name, filePath, userId, savedBy, savedFrom);
              console.log(
                `[qmoji] User: ${userId}, Name: ${name}, Path: ${filePath}, SavedBy: ${savedBy}, SavedFrom: ${savedFrom || 'private'}`
              );
            })
          );

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
        if (currentGroupId === undefined) {
          await send(context, {
            type: 'text',
            data: { text: '无法识别当前群号，保存失败。' }
          });
        } else {
          await save(`chat-${currentGroupId}`);
        }
      }
      if (config.prefixes.save.includes(command[0])) {
        await save(context.user_id.toString());
      }
      if (config.prefixes.use.includes(command[0])) {
        const name = command.slice(1);
        if (!name) {
          return;
        }
        const images = await filterImagesByAction(
          getImagesByNameAndUser(
            name,
            context.user_id.toString(),
            isGroupChat && currentGroupId !== undefined ? currentGroupId.toString() : null,
            true
          ),
          'read'
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
