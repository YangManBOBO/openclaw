let startCount = 0;

const plugin = {
  id: "stuck-channel",
  meta: {
    id: "stuck-channel",
    label: "Stuck Channel",
    selectionLabel: "Stuck Channel",
    docsPath: "/channels/stuck-channel",
    blurb: "Stop-timeout recovery proof channel.",
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: () => ["default"],
    resolveAccount: (_cfg, accountId) => ({ accountId: accountId ?? "default" }),
    isEnabled: () => true,
    isConfigured: () => true,
  },
  gateway: {
    // First start ignores abort and never settles, so a manual stop times out at
    // 5000ms while the task slot stays occupied. A later explicit start reclaims
    // the slot and starts this callback again; the second instance responds to
    // abort so the Gateway can shut down cleanly at the end of the proof.
    startAccount: async ({ abortSignal }) => {
      startCount += 1;
      if (startCount === 1) {
        await new Promise(() => {});
        return;
      }
      await new Promise((resolve) => {
        if (abortSignal.aborted) {
          resolve();
          return;
        }
        abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
    stopAccount: async () => {},
  },
};

export default {
  id: "stuck-channel",
  register(api) {
    api.registerChannel({ plugin });
  },
};
