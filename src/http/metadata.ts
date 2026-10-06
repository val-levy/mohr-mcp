import type { Config } from '../config.js';
import { issuerOf } from './auth.js';

export const MCP_PATH = '/mcp';
/** RFC 9728: where a client learns which authorization server protects this resource. */
export const RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';

export function resourceMetadataUrl(config: Config): string {
  return `${config.publicUrl}${RESOURCE_METADATA_PATH}${MCP_PATH}`;
}

export function resourceMetadata(config: Config) {
  return {
    resource: `${config.publicUrl}${MCP_PATH}`,
    authorization_servers: [issuerOf(config.supabaseUrl)],
    bearer_methods_supported: ['header'],
    resource_name: 'Interview Coach',
  };
}

/** The header that tells a client without a valid token where to start signing in. */
export function challenge(config: Config, error?: 'invalid_token'): string {
  const parts = [`resource_metadata="${resourceMetadataUrl(config)}"`];
  if (error) parts.unshift(`error="${error}"`);
  return `Bearer ${parts.join(', ')}`;
}
