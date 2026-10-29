// Shared settings. The app URL is the TJ Record app's viewer root (no page handle) plus any query
// string it needs; pageUrl() builds page links from it, e.g. the Upload page …/upload?draft=<id>.
// Until TJ Record is released, only its development preview opens (builders only); after release,
// drop the query string so everyone gets the released version.
export const DEFAULT_APP_URL = 'https://app.tooljet.ai/applications/e7397471-54ed-4f4b-acb7-d0437f6342d2?env=development&version=v1';

// Recordings go to S3 through a base64 "upload object" query, which is capped by the server's
// request size limit. 3 minutes at 1.2 Mbps stays under ~27 MB of video.
export const MAX_RECORDING_MS = 3 * 60 * 1000;
export const VIDEO_BITS_PER_SECOND = 1_200_000;

// Instant replay keeps the last REPLAY_WINDOW_MS of a tab in memory; the popup saves the last 1, 2
// or 3 minutes of it (the same size limit as a recording).
export const REPLAY_WINDOW_MS = 3 * 60 * 1000;
export const REPLAY_LENGTHS_MS = [60 * 1000, 2 * 60 * 1000, 3 * 60 * 1000];
// Lower than a recording's: replay adds a keyframe every few seconds (so it can be cut anywhere),
// which pushes the real bitrate above the target. Keeps a busy 3-minute replay near 26 MB.
export const REPLAY_BITS_PER_SECOND = 1_000_000;

export async function getAppUrl() {
  const { appUrl } = await chrome.storage.local.get('appUrl');
  return normalizeAppUrl(appUrl || DEFAULT_APP_URL);
}

export function normalizeAppUrl(value) {
  const url = new URL(String(value).trim());
  if (!/^https?:$/.test(url.protocol)) throw new Error('The TJ Record URL must start with http:// or https://');
  // Accept a pasted page URL (…/applications/<id>/home?env=…) and keep the app root plus env/version.
  const m = url.pathname.match(/^(.*\/applications\/[^/]+)/);
  url.pathname = m ? m[1] : url.pathname.replace(/\/+$/, '');
  ['draft', 'id', 't'].forEach((k) => url.searchParams.delete(k));
  url.hash = '';
  return url.toString().replace(/\/+(\?|$)/, '$1');
}

// origin + path of the app, for "is this page part of TJ Record?" checks.
export const appRoot = (appUrl) => {
  const u = new URL(appUrl);
  return u.origin + u.pathname.replace(/\/+$/, '');
};

export function pageUrl(appUrl, handle, params) {
  const u = new URL(appUrl);
  u.pathname = u.pathname.replace(/\/+$/, '') + '/' + handle;
  Object.entries(params || {}).forEach(([k, v]) => u.searchParams.set(k, v));
  return u.toString();
}
