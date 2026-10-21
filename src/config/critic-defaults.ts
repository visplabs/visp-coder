import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { fromUnknown, isNodeError, vispError } from "../core/errors.js";
import {
  applyFileTransaction,
  filePrecondition,
  withStateMutation,
} from "../core/file-transaction.js";
import { err, ok, type Result } from "../core/result.js";
import {
  balancedCritic,
  type CriticConfig,
  type CriticDefaults,
  configuredCriticMode,
  criticConfigSchema,
  criticDefaultsSchema,
  criticHarnessSchema,
  criticModeSchema,
} from "./critic.js";

import { formatConfigIssues } from "./load.js";

const userSchema = z
  .object({
    version: z.literal(1),
    enabled: z.boolean().optional(),
    mode: criticModeSchema.optional(),
    hosts: z.record(criticHarnessSchema, criticDefaultsSchema),
  })
  .strict();
type UserCriticDefaults = z.infer<typeof userSchema>;
const relativePath = ".config/visp/critic-defaults.json";

export async function readCriticDefaults(home = homedir()) {
  const path = join(home, relativePath);
  let text: string | undefined;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    if (!isNodeError(cause) || cause.code !== "ENOENT") return err(fromUnknown(cause, "IO_ERROR"));
  }
  try {
    const value = userSchema.parse(
      text === undefined ? { version: 1, hosts: {} } : JSON.parse(text),
    );
    return ok({ path, text, value });
  } catch (cause) {
    return err(
      vispError(
        "CONFIG_INVALID",
        `Invalid user critic defaults; fix ~/.config/visp/critic-defaults.json${
          cause instanceof z.ZodError ? `:\n${formatConfigIssues(cause, true)}` : ""
        }`,
      ),
    );
  }
}

/** Explicit settings mutation only. Feature creation merely reads and pins these values. */
export async function saveCriticDefaults(harness: string, input: unknown, home = homedir()) {
  const host = criticHarnessSchema.safeParse(harness);
  const settings = criticDefaultsSchema.safeParse(input);
  if (!settings.success)
    return err(
      vispError(
        "CONFIG_INVALID",
        `Invalid critic defaults:\n${formatConfigIssues(settings.error, true)}`,
      ),
    );
  if (!host.success || (settings.data.harness !== undefined && settings.data.harness !== host.data))
    return err(vispError("CONFIG_INVALID", "Invalid critic harness or defaults"));
  return updateDefaults(home, (previous) => ({
    ...previous,
    hosts: {
      ...previous.hosts,
      [host.data]: {
        ...previous.hosts[host.data],
        ...settings.data,
        ...(settings.data.enabled !== undefined && settings.data.mode === undefined
          ? { mode: undefined }
          : {}),
      },
    },
  }));
}

/** Controls the default for every host without discarding per-host overrides. */
export async function saveCriticEnabled(enabled: boolean, home = homedir()) {
  if (typeof enabled !== "boolean")
    return err(vispError("CONFIG_INVALID", "Critic enabled must be a boolean"));
  return updateDefaults(home, (previous) => ({ ...previous, enabled, mode: undefined }));
}

export async function saveCriticMode(input: unknown, home = homedir()) {
  const mode = criticModeSchema.safeParse(input);
  if (!mode.success)
    return err(vispError("CONFIG_INVALID", "Choose critic mode auto, manual, both or off"));
  return updateDefaults(home, (previous) => ({ ...previous, mode: mode.data }));
}

async function updateDefaults(
  home: string,
  update: (previous: UserCriticDefaults) => UserCriticDefaults,
) {
  return withStateMutation(home, async () => {
    const previous = await readCriticDefaults(home);
    if (!previous.ok) return previous;
    const value = update(previous.value.value);
    const saved = await applyFileTransaction(home, "critic-defaults", [
      {
        kind: "write",
        path: relativePath,
        mode: 0o600,
        content: `${JSON.stringify(value, null, 2)}\n`,
        expectedBefore: filePrecondition(previous.value.text),
      },
    ]);
    return saved.ok
      ? ok({ path: previous.value.path, value, appliesTo: "new features only" })
      : saved;
  });
}

type CriticPolicy = { enabled: boolean; manual?: boolean; config?: CriticConfig };
type CriticSource =
  | "project"
  | "personal-host"
  | "personal-global"
  | "built-in"
  | "workspace-harness";

/** Keep the pinned policy contract unchanged; diagnostics share the same resolution. */
export async function resolveCriticPolicy(
  harness: string,
  project?: CriticDefaults,
  home = homedir(),
): Promise<Result<CriticPolicy>> {
  const resolved = await resolveCriticPolicyDetails(harness, project, home);
  return resolved.ok ? ok(resolved.value.policy) : resolved;
}

export async function resolveCriticPolicyDetails(
  harness: string,
  project?: CriticDefaults,
  home = homedir(),
) {
  const settings = criticDefaultsSchema.safeParse(project ?? {});
  if (!settings.success) return err(fromUnknown(settings.error, "CONFIG_INVALID"));
  const preset = balancedCritic(settings.data.harness ?? harness);
  const read = await readCriticDefaults(home);
  const user =
    !read.ok && !preset?.harness
      ? ok({ value: { version: 1 as const, hosts: {} } as UserCriticDefaults })
      : read;
  if (!user.ok) return user;
  const host = preset?.harness ? user.value.value.hosts[preset.harness] : undefined;
  const sources = {
    mode: resolveModeSource(settings.data, host, user.value.value),
    config: {} as Record<string, CriticSource>,
  };
  const mode = sources.mode.value;
  const enabled = mode === "auto" || mode === "both";
  const manual = mode === "manual" || mode === "both" ? { manual: true } : {};
  if (!enabled) return ok({ policy: { enabled: false, ...manual } as CriticPolicy, sources });
  if (!preset?.harness)
    return ok({ policy: { enabled: true, ...manual } as CriticPolicy, sources });
  const overrides = { ...host, ...settings.data };
  const {
    enabled: _enabled,
    mode: _mode,
    launch: _launch,
    webSearch: _webSearch,
    existingCodeTests: _existingCodeTests,
    leanModel: _leanModel,
    ...options
  } = overrides;
  try {
    const config = criticConfigSchema.parse({ ...preset, ...options, harness: preset.harness });
    for (const key of Object.keys(config) as (keyof CriticConfig)[]) {
      sources.config[key] = configSource(key, settings.data, host);
    }
    return ok({ policy: { enabled: true, ...manual, config } as CriticPolicy, sources });
  } catch (cause) {
    return err(fromUnknown(cause, "CONFIG_INVALID"));
  }
}

function resolveModeSource(
  project: CriticDefaults,
  host: CriticDefaults | undefined,
  user: UserCriticDefaults,
) {
  const layers = [
    { source: "project" as const, settings: project },
    { source: "personal-host" as const, settings: host },
    { source: "personal-global" as const, settings: user },
  ];
  const selected = layers.find((layer) => configuredCriticMode(layer.settings) !== undefined);
  return {
    source: selected?.source ?? "built-in",
    key: selected?.settings?.mode !== undefined ? "mode" : selected ? "enabled" : "mode",
    value: configuredCriticMode(selected?.settings) ?? "auto",
  };
}

function configSource(
  key: keyof CriticConfig,
  project: CriticDefaults,
  host: CriticDefaults | undefined,
): CriticSource {
  if (key === "harness") return project.harness !== undefined ? "project" : "workspace-harness";
  if (project[key] !== undefined) return "project";
  return host?.[key] !== undefined ? "personal-host" : "built-in";
}

/** Compatibility for installation callers that need an available model configuration. */
export async function resolveCriticDefault(
  harness: string,
  project?: CriticDefaults,
  home = homedir(),
) {
  const policy = await resolveCriticPolicy(harness, project, home);
  return policy.ok ? ok(policy.value.config) : policy;
}
