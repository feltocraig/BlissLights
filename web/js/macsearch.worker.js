import { searchMac3 } from './macsearch.js';

self.onmessage = (e) => {
  const { sessionKey, packets } = e.data;
  let found = searchMac3(sessionKey, packets, { onProgress: (p) => self.postMessage({ progress: p }) });
  // Fallback in case this firmware's notifications don't carry the vendor id.
  if (found.length === 0) found = searchMac3(sessionKey, packets, { strict: false, onProgress: (p) => self.postMessage({ progress: p }) });
  self.postMessage({ found });
};
