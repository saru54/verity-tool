// Each website/program has its own form layout, fields, consent requirements, etc.
// Profiles are selected by the operator at task submission time and carry
// per-website overrides for the generic SheerID fill/submit logic.

import spotify from './spotify.js';
import googleOne from './google-one.js';

export const PROFILE_MAP = { spotify, 'google-one': googleOne };
export const PROFILE_KEYS = Object.keys(PROFILE_MAP);

export function getProfile(key) {
  return PROFILE_MAP[key] ?? PROFILE_MAP.spotify;
}
