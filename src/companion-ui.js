import { escapeHTML, option } from './ui-utils.js';

/** Connection credentials live only in the bridge. This surface never serializes them. */
export class CompanionPanel {
  constructor({ bridge, execute, safe }) { Object.assign(this, { bridge, execute, safe }); }
  render(container) {
    container.innerHTML = `<p>Connect to the local companion explicitly. It advertises named destinations and supported encoder profiles; the page itself cannot open UDP sockets.</p><div class="form-grid"><label>Companion endpoint<input id="companion-url" type="url" value="http://127.0.0.1:8787" autocomplete="off" spellcheck="false"></label><label>Per-run token<input id="companion-token" type="password" autocomplete="off" spellcheck="false" placeholder="Token from your local companion"></label></div><div class="inline-buttons"><button id="companion-connect" class="primary">Connect companion</button><button id="companion-disconnect">Disconnect</button></div><p class="field-hint">The token stays in memory, is cleared from this field after connection, and is excluded from settings, projects and macros. Device input must already be active before streaming.</p><div class="form-grid"><label>Named destination<select id="stream-destination"></select></label><label>Encoder profile<select id="stream-profile"></select></label><label>Sample rate<select id="stream-rate"></select></label><label>Channel layout<select id="stream-layout"></select></label><label>Optional bitrate (kb/s)<input id="stream-bitrate" type="number" min="16" max="512" placeholder="Profile default"></label></div><div class="inline-buttons"><button id="stream-start" class="primary">Start stream</button><button id="stream-stop">Stop stream</button><button id="stream-refresh">Refresh status</button></div><output id="companion-state" class="companion-status" role="status"></output><a class="button-link" href="#help/streaming">Companion setup & limits ↗</a>`;
    const $ = selector => container.querySelector(selector);
    let capabilityKey = '';
    const profiles = () => this.bridge.getState().capabilities?.profiles || [];
    const updateProfile = () => { const profile = profiles().find(item => item.id === $('#stream-profile').value); $('#stream-rate').innerHTML = (profile?.rates || []).map(rate => option(rate, `${rate / 1000} kHz`, 48000)).join(''); $('#stream-layout').innerHTML = (profile?.layouts || []).map(layout => option(layout, layout.toUpperCase(), 'stereo')).join(''); };
    const refresh = () => {
      if (!container.isConnected) return; const state = this.bridge.getState(), key = JSON.stringify(state.capabilities || {});
      if (key !== capabilityKey) { capabilityKey = key; $('#stream-destination').innerHTML = (state.capabilities?.destinations || []).map(destination => option(destination.id, destination.label || destination.id, '')).join(''); $('#stream-profile').innerHTML = profiles().map(profile => option(profile.id, profile.label || profile.id, '')).join(''); updateProfile(); }
      $('#companion-state').textContent = `${state.connected ? 'Connected · ' + state.url : 'Disconnected'} · stream ${state.stream?.active ? 'active' : 'stopped'}${state.stream?.id ? ' · ' + state.stream.id : ''}${state.error ? ' · ' + state.error : ''}`;
      $('#companion-disconnect').disabled = !state.connected; $('#stream-start').disabled = !state.connected || Boolean(state.stream?.active) || !profiles().length || !$('#stream-destination').value; $('#stream-stop').disabled = !state.stream?.active; $('#stream-refresh').disabled = !state.connected;
    };
    $('#companion-connect').onclick = () => this.safe(async () => { const token = $('#companion-token').value, button = $('#companion-connect'); button.disabled = true; try { await this.bridge.connect({ url: $('#companion-url').value, token }); $('#companion-token').value = ''; } finally { if (button.isConnected) button.disabled = false; refresh(); } });
    $('#companion-disconnect').onclick = () => this.safe(async () => { await this.bridge.disconnect(); $('#companion-token').value = ''; refresh(); });
    $('#stream-profile').onchange = updateProfile;
    $('#stream-start').onclick = () => this.safe(async () => { const bitrate = $('#stream-bitrate').value; await this.execute('stream.start', { destination: $('#stream-destination').value, profile: $('#stream-profile').value, ...($('#stream-rate').value ? { sampleRate: +$('#stream-rate').value } : {}), ...($('#stream-layout').value ? { layout: $('#stream-layout').value } : {}), ...(bitrate ? { bitrate: +bitrate } : {}) }); refresh(); });
    $('#stream-stop').onclick = () => this.safe(async () => { await this.execute('stream.stop', {}); refresh(); });
    $('#stream-refresh').onclick = () => this.safe(async () => { await this.execute('stream.status', {}); refresh(); });
    this.bridge.addEventListener('state', refresh); refresh();
    return () => { this.bridge.removeEventListener('state', refresh); $('#companion-token').value = ''; };
  }
}
