// Works out why Bluetooth might be unavailable and what to tell the user.
// iPhone/iPad: only Safari + the beacio (formerly WebBLE) extension, or the Bluefy browser,
// provide Web Bluetooth. Chrome/Firefox/Edge on iOS are WebKit shells without extensions.

export function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export const BEACIO_URL = 'https://apps.apple.com/app/id6761301368';
export const BLUEFY_URL = 'https://apps.apple.com/app/id1492822055';

// 'ok' | 'ios-other-browser' | 'ios-standalone' | 'ios-no-extension' | 'ios-extension-off' | 'unsupported' | 'bluetooth-off'
export async function bluetoothSupport() {
  const ios = isIOS();
  const otherIOSBrowser = /CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo|GSA\/|Brave/.test(navigator.userAgent);
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  if (ios && otherIOSBrowser) return 'ios-other-browser';
  if (!navigator.bluetooth) {
    if (ios) return standalone ? 'ios-standalone' : 'ios-no-extension';
    return 'unsupported';
  }
  try {
    if (navigator.bluetooth.getAvailability && !(await navigator.bluetooth.getAvailability())) {
      return ios ? 'ios-extension-off' : 'bluetooth-off';
    }
  } catch { /* some implementations throw; assume it works */ }
  return 'ok';
}

// Undocumented but widely working (iOS 15, 17+) scheme that opens a link in Safari.
export function safariLink(url = location.href) {
  return url.startsWith('https://') ? `x-safari-${url}` : null;
}
