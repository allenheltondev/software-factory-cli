import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router';
import { configureAuth } from '@readysetcloud/ui/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { fakeApi } from '../test/fakeApi';
import { HOLD_MS, holdPassword, takeHeldPassword } from './heldPassword';

const PASSWORD = 'Synthetic-Passw0rd-123';

/**
 * Cognito answers InitiateAuth for an unconfirmed account with UserNotConfirmedException; the
 * package then asks for a fresh code (ResendConfirmationCode) and calls onNeedsConfirmation.
 */
function unconfirmedCognito() {
  return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const target = new Headers(init?.headers).get('x-amz-target') ?? '';
    if (target.endsWith('InitiateAuth')) {
      return new Response(JSON.stringify({ __type: 'UserNotConfirmedException', message: 'User is not confirmed.' }), {
        status: 400,
        headers: { 'content-type': 'application/x-amz-json-1.1' },
      });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/x-amz-json-1.1' } });
  });
}

describe('unconfirmed-account sign-in', () => {
  beforeEach(() => {
    configureAuth({ region: 'us-east-1', clientId: 'test-client', sharedCookieDomain: '' });
    window.history.replaceState(null, '', '/login');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reaches the confirm step without putting the password in browser history', async () => {
    const fetchMock = unconfirmedCognito();
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <BrowserRouter>
        <App api={fakeApi()} />
      </BrowserRouter>,
    );

    await user.type(await screen.findByLabelText('Email'), 'pat@example.com');
    await user.type(screen.getByLabelText('Password'), PASSWORD);
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(window.location.pathname).toBe('/signup/confirm'));
    expect(JSON.stringify(window.history.state)).not.toContain(PASSWORD);
    expect(JSON.stringify(window.history.state)).toContain('pat@example.com');
    // The screen took the password; module memory no longer holds it.
    expect(takeHeldPassword('pat@example.com')).toBeUndefined();
  });
});

describe('heldPassword', () => {
  it('hands the password over once, for the same email only', () => {
    holdPassword('a@b.c', 'pw', 0);
    expect(takeHeldPassword('a@b.c', 1)).toBe('pw');
    expect(takeHeldPassword('a@b.c', 2)).toBeUndefined();

    holdPassword('a@b.c', 'pw', 0);
    expect(takeHeldPassword('other@b.c', 1)).toBeUndefined();
    expect(takeHeldPassword('a@b.c', 2)).toBeUndefined();
  });

  it('drops a password held too long', () => {
    holdPassword('a@b.c', 'pw', 0);
    expect(takeHeldPassword('a@b.c', HOLD_MS + 1)).toBeUndefined();
  });

  it('holds nothing without a password', () => {
    holdPassword('a@b.c', undefined, 0);
    expect(takeHeldPassword('a@b.c', 1)).toBeUndefined();
  });
});
