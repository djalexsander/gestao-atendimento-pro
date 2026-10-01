import type { StartupPort } from "../src/core/app.ts";

// Ponte nativa falsa: registra tudo o que o app pede ao sistema (autostart, bandeja, avisos).
export function fakeStartup(opts: { autostartEnabled?: boolean; hidden?: boolean; failAutostart?: boolean } = {}) {
  const calls = {
    setAutostart: [] as boolean[],
    notify: [] as string[],
    tray: [] as string[],
    showWindow: 0,
  };
  let enabled = opts.autostartEnabled ?? false;
  const port: StartupPort = {
    async setAutostart(v) {
      if (opts.failAutostart) throw new Error("registro indisponível");
      calls.setAutostart.push(v);
      enabled = v;
    },
    async isAutostartEnabled() {
      return enabled;
    },
    async launchedHidden() {
      return opts.hidden ?? false;
    },
    async setTrayStatus(connection, mode) {
      calls.tray.push(`${connection}/${mode}`);
    },
    async notify(_title, body) {
      calls.notify.push(body);
    },
    async showWindow() {
      calls.showWindow += 1;
    },
  };
  return { port, calls, isEnabled: () => enabled };
}
