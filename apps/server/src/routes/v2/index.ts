/**
 * V2 API — mount all v2 routes.
 */

import { Hono } from 'hono';
import { sessionRoutes } from './session.js';
import { turnRoutes } from './turn.js';
import { pluginRoutes } from './plugins.js';
import { stateRoutes } from './state.js';
import { eventRoutes } from './events.js';
import { runtimeRoutes } from './runtime.js';
import { healthRoutes } from './health.js';

export const v2Api = new Hono();

v2Api.route('/session', sessionRoutes);
v2Api.route('/session', turnRoutes);
v2Api.route('/plugins', pluginRoutes);
v2Api.route('/session', stateRoutes);
v2Api.route('/events', eventRoutes);
v2Api.route('/runtime', runtimeRoutes);
v2Api.route('/health', healthRoutes);
