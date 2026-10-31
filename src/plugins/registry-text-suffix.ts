import type { PluginRuntime } from "./runtime/types.js";

/** The retained optional capability has the same registry lifetime as its channel owner. */
export function guardRegistryTextSuffix(
  suffix: PluginRuntime["channel"]["outboundTextSuffix"],
  assertRuntimeCurrent: () => void,
  invokeSelectedRuntime: <T>(run: () => T) => T,
): Pick<PluginRuntime["channel"], "outboundTextSuffix"> {
  if (!suffix) {
    return {};
  }
  return {
    outboundTextSuffix: {
      version: suffix.version,
      capture: (...args) => {
        assertRuntimeCurrent();
        return suffix.capture(...args);
      },
      bind: (...args) => {
        assertRuntimeCurrent();
        return suffix.bind(...args);
      },
      normalizeTerminalSignature: (...args) => {
        assertRuntimeCurrent();
        return suffix.normalizeTerminalSignature(...args);
      },
      finalize: (...args) => {
        assertRuntimeCurrent();
        return suffix.finalize(...args);
      },
      planPreservedMarkdownText: async (...args) => {
        assertRuntimeCurrent();
        const result = await invokeSelectedRuntime(() => suffix.planPreservedMarkdownText(...args));
        assertRuntimeCurrent();
        return result;
      },
    },
  };
}
