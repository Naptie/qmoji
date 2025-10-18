import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { randomUUID } from 'crypto';

export type PermissionAction = 'read' | 'create' | 'remove';
export type PermissionScope = 'global' | 'group' | 'personal';

type PolicySelectorType =
  | 'admin'
  | 'allowlist_user'
  | 'everyone'
  | 'user'
  | 'group'
  | 'groupadmin'
  | 'owner'
  | 'group_member';

export interface PolicySelector {
  type: PolicySelectorType;
  value?: string;
}

export interface PolicyRule {
  id: string;
  scope: PermissionScope;
  selector: PolicySelector;
  permissions: Record<PermissionAction, boolean>;
  priority: number;
  createdAt: number;
}

interface PolicyStorage {
  custom: PolicyRule[];
}

export interface ActorContext {
  userId: number;
  groupId?: number;
  isAdmin: boolean;
  isAllowlistUser: boolean;
  isAllowlistGroup: boolean;
  isGroupAdmin?: (groupId: string) => Promise<boolean>;
}

export interface TargetContext {
  scope: PermissionScope;
  ownerId?: string;
  groupId?: string;
}

interface CreatePolicyManagerOptions {
  filePath: string;
  defaultRules: PolicyRule[];
}

const defaultStorage: PolicyStorage = { custom: [] };

const ensureFile = (filePath: string) => {
  if (!existsSync(filePath)) {
    const dirPath = dirname(filePath);
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
    }
    writeFileSync(filePath, JSON.stringify(defaultStorage, null, 2), 'utf-8');
  }
};

const loadStorage = (filePath: string): PolicyStorage => {
  ensureFile(filePath);
  const raw = readFileSync(filePath, 'utf-8');
  try {
    const parsed = JSON.parse(raw) as PolicyStorage;
    if (!parsed.custom) {
      return { custom: [] };
    }
    return parsed;
  } catch {
    return { ...defaultStorage };
  }
};

const saveStorage = (filePath: string, storage: PolicyStorage) => {
  writeFileSync(filePath, JSON.stringify(storage, null, 2), 'utf-8');
};

const sortRules = (rules: PolicyRule[]) => {
  return [...rules].sort((a, b) => {
    if (a.priority === b.priority) {
      return b.createdAt - a.createdAt;
    }
    return b.priority - a.priority;
  });
};

const ruleKey = (scope: PermissionScope, selector: PolicySelector) =>
  `${scope}|${selector.type}|${selector.value ?? ''}`;

const dedupeRules = (rules: PolicyRule[], keep: 'newest' | 'oldest' = 'newest') => {
  const seen = new Set<string>();
  const result: PolicyRule[] = [];
  const ordered = keep === 'newest' ? [...rules].sort((a, b) => b.createdAt - a.createdAt) : sortRules(rules);
  for (const rule of ordered) {
    const key = ruleKey(rule.scope, rule.selector);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(cloneRule(rule));
  }
  return result;
};

const cloneRule = (rule: PolicyRule): PolicyRule => ({
  ...rule,
  selector: { ...rule.selector },
  permissions: { ...rule.permissions }
});

const cloneRules = (rules: PolicyRule[]) => rules.map(cloneRule);

const selectorsEqual = (a: PolicySelector, b: PolicySelector) => {
  return a.type === b.type && (a.value ?? '') === (b.value ?? '');
};

const defaultPermissionTemplates: Record<PermissionScope, Record<PermissionAction, boolean>> = {
  global: { read: true, create: true, remove: false },
  group: { read: true, create: true, remove: true },
  personal: { read: true, create: true, remove: true }
};

const sanitizePermissions = (permissions: Record<PermissionAction, boolean>) => ({
  read: Boolean(permissions.read),
  create: Boolean(permissions.create),
  remove: Boolean(permissions.remove)
});

const matchesSelector = async (
  selector: PolicySelector,
  actor: ActorContext,
  target: TargetContext
): Promise<boolean> => {
  switch (selector.type) {
    case 'admin':
      return actor.isAdmin;
    case 'allowlist_user':
    case 'everyone':
      return actor.isAllowlistUser || actor.isAllowlistGroup;
    case 'user':
      return selector.value !== undefined && actor.userId.toString() === selector.value;
    case 'group':
      return Boolean(selector.value && target.groupId && target.groupId === selector.value);
    case 'groupadmin': {
      if (!actor.isGroupAdmin) {
        return false;
      }
      const groupId = selector.value ?? target.groupId;
      return groupId ? await actor.isGroupAdmin(groupId) : false;
    }
    case 'owner':
      return Boolean(target.ownerId && target.ownerId === actor.userId.toString());
    case 'group_member':
      return Boolean(target.groupId && actor.groupId !== undefined && target.groupId === actor.groupId.toString());
    default:
      return false;
  }
};

const pickRule = async (
  rules: PolicyRule[],
  actor: ActorContext,
  target: TargetContext
): Promise<PolicyRule | null> => {
  const scopedRules = rules.filter((rule) => rule.scope === target.scope);
  if (!scopedRules.length) {
    return null;
  }
  const sorted = sortRules(scopedRules);
  for (const rule of sorted) {
    if (await matchesSelector(rule.selector, actor, target)) {
      return rule;
    }
  }
  return null;
};

export const createPolicyManager = ({
  filePath,
  defaultRules
}: CreatePolicyManagerOptions) => {
  const storage = loadStorage(filePath);
  const defaults = dedupeRules(defaultRules, 'oldest');
  const defaultPriorityMap = new Map<string, number>();
  for (const rule of defaults) {
    defaultPriorityMap.set(ruleKey(rule.scope, rule.selector), rule.priority);
  }
  const originalLength = storage.custom.length;
  storage.custom = dedupeRules(storage.custom, 'newest');
  if (storage.custom.length !== originalLength) {
    saveStorage(filePath, storage);
  }

  const resolvePriority = (scope: PermissionScope, selector: PolicySelector) => {
    const key = ruleKey(scope, selector);
    if (defaultPriorityMap.has(key)) {
      return defaultPriorityMap.get(key)!;
    }
    return 0;
  };

  const addCustomRule = (rule: Omit<PolicyRule, 'id' | 'createdAt'>): PolicyRule => {
    const newRule: PolicyRule = {
      ...rule,
      id: randomUUID(),
      priority: rule.priority ?? resolvePriority(rule.scope, rule.selector),
      createdAt: Date.now()
    };
    const key = ruleKey(newRule.scope, newRule.selector);
    storage.custom = storage.custom.filter((existing) => ruleKey(existing.scope, existing.selector) !== key);
    storage.custom.push(newRule);
    saveStorage(filePath, storage);
    return newRule;
  };

  const isAllowed = async (
    actor: ActorContext,
    target: TargetContext,
    action: PermissionAction
  ): Promise<boolean> => {
    const rule = await pickRule(storage.custom, actor, target);
    if (rule) {
      return Boolean(rule.permissions[action]);
    }
    const fallback = await pickRule(defaults, actor, target);
    if (fallback) {
      return Boolean(fallback.permissions[action]);
    }
    return false;
  };

  const getCustomRules = () => cloneRules(storage.custom);

  const updateRule = (
    scope: PermissionScope,
    selector: PolicySelector,
    priority: number | undefined,
    mutator: (permissions: Record<PermissionAction, boolean>) => Record<PermissionAction, boolean>
  ): { rule: PolicyRule; created: boolean } => {
    const index = storage.custom.findIndex(
      (rule) => rule.scope === scope && selectorsEqual(rule.selector, selector)
    );
    const basePermissions = index >= 0
      ? { ...storage.custom[index].permissions }
      : { ...defaultPermissionTemplates[scope] };
    const updatedPermissions = sanitizePermissions(mutator({ ...basePermissions }));
    const targetPriority = priority ?? (index >= 0
      ? storage.custom[index].priority
      : resolvePriority(scope, selector));
    if (index >= 0) {
      const existing = storage.custom[index];
      const updatedRule: PolicyRule = {
        ...existing,
        permissions: updatedPermissions,
        priority: targetPriority,
        createdAt: Date.now()
      };
      storage.custom[index] = updatedRule;
      saveStorage(filePath, storage);
      return { rule: cloneRule(updatedRule), created: false };
    }
    const newRule: PolicyRule = {
      id: randomUUID(),
      scope,
      selector: { ...selector },
      permissions: updatedPermissions,
      priority: targetPriority,
      createdAt: Date.now()
    };
    storage.custom.push(newRule);
    saveStorage(filePath, storage);
    return { rule: cloneRule(newRule), created: true };
  };

  const setRulePermissions = (
    scope: PermissionScope,
    selector: PolicySelector,
    priority: number | undefined,
    permissions: Record<PermissionAction, boolean>
  ) => updateRule(scope, selector, priority, () => permissions);

  const updateSinglePermission = (
    scope: PermissionScope,
    selector: PolicySelector,
    priority: number | undefined,
    action: PermissionAction,
    value: boolean
  ) =>
    updateRule(scope, selector, priority, (current) => ({
      ...current,
      [action]: value
    }));

  const removeRules = (
    scope: PermissionScope | undefined,
    selector: PolicySelector | undefined,
    priority: number | undefined,
    removeAll = true
  ) => {
    const matches = storage.custom
      .map((rule, index) => ({ rule, index }))
      .filter(
        ({ rule }) =>
          (scope ? rule.scope === scope : true) &&
          (selector ? selectorsEqual(rule.selector, selector) : true) &&
          (priority === undefined || rule.priority === priority)
      );

    if (!matches.length) {
      return [] as PolicyRule[];
    }

    // 保留最新创建的规则
    const sorted = matches.sort((a, b) => b.rule.createdAt - a.rule.createdAt);
    const target = removeAll ? sorted : sorted.slice(0, 1);
    const indices = target.map((item) => item.index).sort((a, b) => b - a);
    const removedRules: PolicyRule[] = [];
    for (const idx of indices) {
      const [removed] = storage.custom.splice(idx, 1);
      if (removed) {
        removedRules.push(cloneRule(removed));
      }
    }
    saveStorage(filePath, storage);
    return removedRules;
  };

  const listRules = () => ({
    custom: sortRules(storage.custom).map(cloneRule),
    defaults: cloneRules(defaults)
  });
  
  const getDefaultRules = () => cloneRules(defaults);

  return {
    addCustomRule,
    isAllowed,
    getCustomRules,
    getDefaultRules,
    listRules,
    setRulePermissions,
    updateSinglePermission,
    removeRules
  };
};

export type PolicyManager = ReturnType<typeof createPolicyManager>;
