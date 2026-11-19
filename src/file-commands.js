/** Pure concrete I/O contracts shared by browser and Node adapters. */
const AUDIO_FORMAT_IDS = ['wav','mp3','flac','ogg','opus','m4a','aac','aiff','alac','wma'];
const property = (type, description, extra = {}) => ({ type, description, ...extra });
const exportProperties = {
  scope: property('string', 'Export scope', { enum: ['mix', 'track', 'clip', 'selection'] }),
  trackId: property('string', 'Explicit track ID'), clipId: property('string', 'Explicit clip ID'),
  format: property('string', 'Audio or project format', { enum: [...AUDIO_FORMAT_IDS, 'session', 'aup3', 'aup', 'reaper'] }),
  name: property('string', 'Download filename stem', { maxLength: 200 }),
  outputLayout: property('string', 'Explicit rendered speaker layout', { enum: ['mono', 'stereo', '5.1', '7.1'] }),
  sampleRate: property('number', 'Export sample rate', { minimum: 8000, maximum: 192000 }),
  bitDepth: property('integer', 'PCM bit depth', { enum: [16, 24, 32] }), bitrate: property('number', 'Lossy kb/s', { minimum: 16, maximum: 512 }),
  raw: property('boolean', 'Bypass track gain and pan'), live: property('boolean', 'Render the current live rack and automation from empty history'),
  respectMute: property('boolean', 'Honor track mute'), respectSolo: property('boolean', 'Honor solo state'),
  start: property('number', 'Timeline/range start seconds', { minimum: 0, maximum: 600 }), end: property('number', 'Range end seconds', { minimum: 0, maximum: 600 }),
  download: property('boolean', 'Download the result'), multichannel: property('string', 'Audacity surround policy', { enum: ['reject', 'split-mono'] }),
};
export const FILE_COMMANDS = [
  { method: 'file.import', id: 'file.import', label: 'Import a supplied file', category: 'Files', description: 'Import an explicitly supplied file alias into the project. No arbitrary paths or URLs are read.', schema: { type: 'object', properties: { input: { description: 'Supplied input alias or alias record' }, replace: { type: 'boolean' }, name: { type: 'string', maxLength: 200 }, trackId: { type: 'string' }, start: { type: 'number', minimum: 0, maximum: 600 } }, required: ['input'], additionalProperties: false }, recordable: true, undoable: true, capabilities: ['files'] },
  { method: 'file.export', id: 'file.export', label: 'Export audio or a session', category: 'Files', description: 'Export an explicit scope as committed audio, a live-settings render, or a supported editable project.', schema: { type: 'object', properties: exportProperties, additionalProperties: false }, recordable: true, undoable: false, capabilities: ['files'] },
  { method: 'file.exportStems', id: 'file.exportStems', label: 'Export individual track stems', category: 'Files', description: 'Render tracks independently with collision-free filenames in a bounded ZIP. Mute and solo are ignored unless explicitly requested.', schema: { type: 'object', properties: { ...exportProperties, trackIds: { type: 'array', items: { type: 'string' }, maxItems: 64 }, align: { type: 'boolean' } }, additionalProperties: false }, recordable: true, undoable: false, capabilities: ['files'] }
];
