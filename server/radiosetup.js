import { config } from './config.js';
import { CANONICAL_BOSE_URLS, isSafeConsoleUrl, parseSystemConfiguration, runConsole } from './soundtouch/console.js';
import { HttpError, tcpProbe } from './net.js';
import { logger } from './log.js';

const log = logger('radio-setup');

/**
 * Points a speaker's BMX service registry at this hub, which restores
 * internet radio and the six hardware preset buttons after Bose's cloud
 * shutdown. Only the registry URL is changed; the original value is saved
 * so it can be restored at any time. Nothing is installed on the speaker.
 *
 * Mechanism (community-verified on firmware 27):
 *   sys configuration bmxRegistryUrl <url>      -> runtime setting
 *   envswitch boseurls set <marge> <swupdate>   -> persists current settings
 *   getpdo CurrentSystemConfiguration           -> read back / verify
 */
export class RadioSetup {
  constructor(hub) {
    this.hub = hub;
    this.busy = new Set();
  }

  console(sp, commands) {
    return runConsole(sp.ip, commands, { port: config.speakerPorts.console, delay: config.consoleDelayMs });
  }

  async readConfig(sp) {
    const [out] = await this.console(sp, ['getpdo CurrentSystemConfiguration']);
    return { raw: out, values: parseSystemConfiguration(out) };
  }

  async status(id) {
    const sp = this.hub.onlineSpeaker(id);
    const registryUrl = `${await this.hub.hubBaseFor(sp)}/bmx/registry/v1/services`;
    const consoleReachable = await tcpProbe(sp.ip, config.speakerPorts.console, 2000);
    let current = null;
    if (consoleReachable) {
      try {
        current = (await this.readConfig(sp)).values;
      } catch (err) {
        log.debug(`getpdo failed: ${err.message}`);
      }
    }
    const firmwareMajor = Number.parseInt(sp.state.info?.firmware || '', 10) || null;
    return {
      consoleReachable,
      firmware: sp.state.info?.firmware || '',
      firmwareOk: firmwareMajor == null || firmwareMajor >= 27,
      accountLinked: !!sp.state.info?.accountId,
      expectedRegistryUrl: registryUrl,
      currentRegistryUrl: current?.bmxRegistryUrl || null,
      pointsToHub: current?.bmxRegistryUrl ? current.bmxRegistryUrl === registryUrl : null,
      managedByOtherTool: current ? this.otherTool(current) : null,
      radio: this.hub.publicSpeaker(sp).radio,
    };
  }

  /** Detect speakers already modified by another community tool. */
  otherTool(values) {
    const marge = values.margeServerUrl || '';
    if (marge && !isSafeConsoleUrl(marge)) return 'Another tool has installed a start-up hook on this speaker';
    return null;
  }

  async enable(id, { reboot = false } = {}) {
    const sp = this.hub.onlineSpeaker(id);
    if (this.busy.has(id)) throw new HttpError(409, 'Setup is already running for this speaker');
    this.busy.add(id);
    try {
      if (!(await tcpProbe(sp.ip, config.speakerPorts.console, 3000))) {
        throw new HttpError(
          502,
          "The speaker's maintenance console (port 17000) isn't reachable. Make sure the hub and speaker are on the same network.",
          'console_unreachable',
        );
      }
      const registryUrl = `${await this.hub.hubBaseFor(sp)}/bmx/registry/v1/services`;
      if (!isSafeConsoleUrl(registryUrl)) throw new HttpError(500, `Hub address ${registryUrl} can't be written to the speaker`);

      const before = await this.readConfig(sp);
      const values = before.values;
      const other = this.otherTool(values);
      if (other) {
        throw new HttpError(409, `${other}. Remove it with that tool first, then try again.`, 'other_tool');
      }

      // Back up the original values exactly once (never overwrite a backup with our own URL).
      const radio = this.hub.radioInfo(id) || {};
      const isOurs = (u) => !!u && /\/bmx\/registry\/v1\/services$/.test(u) && !/bose/i.test(u);
      if (!radio.original && !isOurs(values.bmxRegistryUrl)) {
        this.hub.setRadioInfo(id, {
          original: {
            bmxRegistryUrl: values.bmxRegistryUrl || CANONICAL_BOSE_URLS.bmxRegistryUrl,
            margeServerUrl: values.margeServerUrl || CANONICAL_BOSE_URLS.margeServerUrl,
            swUpdateUrl: values.swUpdateUrl || CANONICAL_BOSE_URLS.swUpdateUrl,
            savedAt: Date.now(),
            raw: before.raw.slice(0, 4000),
          },
        });
      }

      const marge = isSafeConsoleUrl(values.margeServerUrl) ? values.margeServerUrl : CANONICAL_BOSE_URLS.margeServerUrl;
      const sw = isSafeConsoleUrl(values.swUpdateUrl) ? values.swUpdateUrl : CANONICAL_BOSE_URLS.swUpdateUrl;

      log.info(`${sp.state.name}: pointing radio registry at ${registryUrl}`);
      const outputs = await this.console(sp, [`sys configuration bmxRegistryUrl ${registryUrl}`, `envswitch boseurls set ${marge} ${sw}`]);
      const persisted = /Setting Bose Server URLs/i.test(outputs.join('\n'));

      const after = await this.readConfig(sp).catch(() => ({ values: {} }));
      const verified = after.values.bmxRegistryUrl === registryUrl;
      if (after.values.bmxRegistryUrl && !verified) {
        throw new HttpError(502, `The speaker did not accept the new setting (it still reports ${after.values.bmxRegistryUrl}).`, 'not_applied');
      }

      this.hub.setRadioInfo(id, {
        status: 'enabled',
        registryUrl,
        enabledAt: Date.now(),
        verified,
        persisted,
        nativeOk: null,
        addressMismatch: false,
      });

      if (reboot) await this.reboot(id);
      return { ok: true, verified, persisted, rebooting: !!reboot, registryUrl };
    } finally {
      this.busy.delete(id);
    }
  }

  async disable(id, { reboot = false } = {}) {
    const sp = this.hub.onlineSpeaker(id);
    if (this.busy.has(id)) throw new HttpError(409, 'Setup is already running for this speaker');
    this.busy.add(id);
    try {
      const radio = this.hub.radioInfo(id) || {};
      const original = radio.original || {};
      const bmx = isSafeConsoleUrl(original.bmxRegistryUrl) ? original.bmxRegistryUrl : CANONICAL_BOSE_URLS.bmxRegistryUrl;
      const current = (await this.readConfig(sp).catch(() => ({ values: {} }))).values;
      const marge = isSafeConsoleUrl(current.margeServerUrl) ? current.margeServerUrl : original.margeServerUrl || CANONICAL_BOSE_URLS.margeServerUrl;
      const sw = isSafeConsoleUrl(current.swUpdateUrl) ? current.swUpdateUrl : original.swUpdateUrl || CANONICAL_BOSE_URLS.swUpdateUrl;
      await this.console(sp, [`sys configuration bmxRegistryUrl ${bmx}`, `envswitch boseurls set ${marge} ${sw}`]);
      const after = await this.readConfig(sp).catch(() => ({ values: {} }));
      if (after.values.bmxRegistryUrl && after.values.bmxRegistryUrl !== bmx) {
        throw new HttpError(502, 'The speaker did not accept the restored setting. Try again.', 'not_applied');
      }
      this.hub.setRadioInfo(id, { status: 'disabled', registryUrl: '', nativeOk: null, addressMismatch: false, disabledAt: Date.now() });
      if (reboot) await this.reboot(id);
      return { ok: true, restoredTo: bmx, rebooting: !!reboot };
    } finally {
      this.busy.delete(id);
    }
  }

  async reboot(id) {
    const sp = this.hub.onlineSpeaker(id);
    log.info(`${sp.state.name}: restarting`);
    await this.console(sp, ['sys reboot']);
    sp.markOnline(false);
    return { ok: true };
  }
}
