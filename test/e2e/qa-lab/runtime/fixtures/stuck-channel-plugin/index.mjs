let startCount = 0;
let releaseFirstStart = () => {};
const firstStartHeld = new Promise((resolve) => {
  releaseFirstStart = resolve;
});

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
    // First start ignores abort and never settles on its own, so a manual stop
    // times out at 5000ms while the task slot stays occupied. The recovery
    // explicit start reclaims the slot and invokes this callback again; that
    // second invocation releases the first so the Gateway can shut down
    // cleanly at the end of the proof.
    startAccount: async ({ abortSignal }) => {
      startCount += 1;
      if (startCount === 1) {
        await firstStartHeld;
        return;
      }
      releaseFirstStart();
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
