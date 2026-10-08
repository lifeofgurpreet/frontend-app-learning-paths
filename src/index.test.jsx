import { waitFor } from '@testing-library/react';
import fs from 'fs';
import path from 'path';

// Execute the real frontend-platform initialization pipeline. Only its services and
// the DOM render boundary are isolated; the application's auth flags are untouched.
jest.mock('@edx/frontend-platform', () => {
  const actual = jest.requireActual('@edx/frontend-platform');
  const { MockAuthService } = jest.requireActual('@edx/frontend-platform/auth');
  const { MockLoggingService } = jest.requireActual('@edx/frontend-platform/logging');
  const { MockAnalyticsService } = jest.requireActual('@edx/frontend-platform/analytics');
  return {
    ...actual,
    initialize: jest.fn(options => actual.initialize({
      ...options,
      authService: MockAuthService,
      loggingService: MockLoggingService,
      analyticsService: MockAnalyticsService,
      externalScripts: [],
      handlers: {
        ...options.handlers,
        config: () => {
          options.handlers.config();
          actual.mergeConfig({ authenticatedUser: global.bootstrapUser });
        },
      },
    })),
  };
});

jest.mock('react-dom/client', () => ({
  createRoot: jest.fn(() => ({ render: jest.fn() })),
}));

test.each([null, {
  userId: '7', username: 'learner', roles: [], administrator: false,
}])(
  'native startup reaches APP_READY without forced login and retains hydrated identity: %s',
  async user => {
    jest.resetModules();
    global.bootstrapUser = user;
    document.body.innerHTML = '<div id="root"></div>';
    await import('./index');
    const platform = await import('@edx/frontend-platform');
    const { getAuthService } = await import('@edx/frontend-platform/auth');
    const { default: ReactDOM } = await import('react-dom/client');
    await platform.initialize.mock.results[0].value;
    await waitFor(() => expect(ReactDOM.createRoot).toHaveBeenCalledTimes(1));
    const service = getAuthService();
    expect(service.fetchAuthenticatedUser).toHaveBeenCalledTimes(1);
    expect(service.ensureAuthenticatedUser).not.toHaveBeenCalled();
    expect(service.redirectToLogin).not.toHaveBeenCalled();
    expect(service.getAuthenticatedUser()).toEqual(user);
    expect(service.hydrateAuthenticatedUser).toHaveBeenCalledTimes(user ? 1 : 0);
    expect(ReactDOM.createRoot.mock.results[0].value.render).toHaveBeenCalledTimes(1);
    delete global.bootstrapUser;
  },
  60000,
);

describe('native stylesheet authority', () => {
  const stylesheet = fs.readFileSync(path.join(__dirname, 'index.css'), 'utf8');
  const roles = new Set([
    '--pgn-color-primary-500', '--pgn-color-secondary-base', '--pgn-color-gray-700',
  ]);

  function violations(css) {
    const failures = [];
    const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
    if (/(?:^|[;{])\s*--[\w-]+\s*:/.test(source)) {
      failures.push('private-palette');
    }
    for (const match of source.matchAll(/var\(\s*(--[\w-]+)/g)) {
      if (!roles.has(match[1])) {
        failures.push('unowned-token');
      }
    }
    // Top-level button tiers are the source defect. Component-scoped search
    // controls below .dashboard are retained, including their native hover API.
    let depth = 0;
    let start = 0;
    for (let position = 0; position < source.length; position += 1) {
      if (source[position] === '{') {
        if (depth === 0 && /^button(?:\b|[.#[:])/.test(source.slice(start, position).trim())) {
          failures.push('global-button-tier');
        }
        depth += 1;
      } else if (source[position] === '}') {
        depth -= 1;
        if (depth === 0) {
          start = position + 1;
        }
      }
    }
    return [...new Set(failures)];
  }

  test('real native source consumes only existing shared roles and leaves button tiers to Paragon', () => {
    expect(violations(stylesheet)).toEqual([]);
    const used = new Set([...stylesheet.matchAll(/var\(\s*(--[\w-]+)/g)].map(match => match[1]));
    expect(used).toEqual(roles);
  });

  test.each([
    [':root { --crimson: #821123; }', 'private-palette'],
    ['.lp-chip { color: var(--crimson); }', 'unowned-token'],
    ['.lp-chip { color: var(--pgn-color-foreign-role); }', 'unowned-token'],
    ['button { &.btn-primary { background: #821122 !important; } }', 'global-button-tier'],
  ])('valid CSS corruption %s refuses at its responsible authority boundary', (mutation, reason) => {
    expect(violations(stylesheet + mutation)).toContain(reason);
  });
});
