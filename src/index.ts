// inspired by https://github.com/parro-it/electron-google-oauth
const { shell,BrowserWindow, remote } = window.require('electron');
import { EventEmitter } from 'events';
import { OAuth2Client } from 'google-auth-library';
import { Credentials } from 'google-auth-library/build/src/auth/credentials';
import { stringify } from 'querystring';
import * as url from 'url';
import LoopbackRedirectServer from './LoopbackRedirectServer';

const BW: typeof BrowserWindow = remote.BrowserWindow;

export class UserClosedWindowError extends Error {
  constructor() {
    super('User closed the window');
  }
}

/**
 * Tokens updated event
 *
 * @event ElectronGoogleOAuth2#tokens
 * @type {Credentials}
 */

export type ElectronGoogleOAuth2Options = {
  successRedirectURL: string,
  loopbackInterfaceRedirectionPort: number,
  refocusAfterSuccess: boolean,
};

export const defaultElectronGoogleOAuth2Options: ElectronGoogleOAuth2Options = {
  successRedirectURL: 'https://getstation.com/app-login-success/',
  // can't be randomized
  loopbackInterfaceRedirectionPort: 42813,
  refocusAfterSuccess: true,
};

/**
 * Handle Google Auth processes through Electron.
 * This class automatically renews expired tokens.
 * @fires ElectronGoogleOAuth2#tokens
 */
export default class ElectronGoogleOAuth2 extends EventEmitter {

  public oauth2Client: OAuth2Client;
  public scopes: string[];
  protected server: LoopbackRedirectServer | null;
  protected options: ElectronGoogleOAuth2Options;

  /**
   * Create a new instance of ElectronGoogleOAuth2
   * @param {string} clientId - Google Client ID
   * @param {string} clientSecret - Google Client Secret
   * @param {string[]} scopes - Google scopes. 'profile' and 'email' will always be present
   * @param {Partial<ElectronGoogleOAuth2Options>} options
   */
  constructor(
    clientId: string,
    clientSecret: string,
    scopes: string[],
    options: Partial<ElectronGoogleOAuth2Options> = defaultElectronGoogleOAuth2Options,
  ) {
    super();
    // Force fetching id_token if not provided
    if (!scopes.includes('profile')) scopes.push('profile');
    if (!scopes.includes('email')) scopes.push('email');
    this.scopes = scopes;
    this.options = { ...defaultElectronGoogleOAuth2Options, ...options };
    this.oauth2Client = new OAuth2Client(
      clientId,
      clientSecret,
      `http://127.0.0.1:${this.options.loopbackInterfaceRedirectionPort}/callback`
    );
    this.oauth2Client.on('tokens', (tokens) => {
      this.emit('tokens', tokens);
    });
  }

  /**
   * Returns authUrl generated by googleapis
   * @param {boolean} forceAddSession
   * @returns {string}
   */
  generateAuthUrl(forceAddSession: boolean = false) {
    let url = this.oauth2Client.generateAuthUrl({
      access_type: 'offline', // 'online' (default) or 'offline' (gets refresh_token)
      scope: this.scopes,
      redirect_uri: `http://127.0.0.1:${this.options.loopbackInterfaceRedirectionPort}/callback`
    });

    if (forceAddSession) {
      const qs = stringify({ continue: url });
      url = `https://accounts.google.com/AddSession?${qs}`;
    }

    return url;
  }

  /**
   * Get authorization code for underlying authUrl
   * @param {boolean} forceAddSession
   * @returns {Promise<string>}
   */
  getAuthorizationCode(forceAddSession: boolean = false) {
    const url = this.generateAuthUrl(forceAddSession);
    return this.openAuthWindowAndGetAuthorizationCode(url);
  }

  /**
   * Get authorization code for given url
   * @param {string} urlParam
   * @returns {Promise<string>}
   */
  openAuthWindowAndGetAuthorizationCode(urlParam: string) {
    return this.openAuthPageAndGetAuthorizationCode(urlParam);
  }

  async openAuthPageAndGetAuthorizationCode(urlParam: string) {
    if (this.server) {
      // if a server is already running, we close it so that we free the port
      // and restart the process
      await this.server.close();
      this.server = null;
    }
    this.server = new LoopbackRedirectServer({
      port: this.options.loopbackInterfaceRedirectionPort,
      callbackPath: '/callback',
      successRedirectURL: this.options.successRedirectURL,
    });

    shell.openExternal(urlParam);

    const reachedCallbackURL = await this.server.waitForRedirection();

    // waitForRedirection will close the server
    this.server = null;

    const parsed = url.parse(reachedCallbackURL, true);
    if (parsed.query.error) {
      throw new Error(parsed.query.error_description as string);
    } else if (!parsed.query.code) {
      throw new Error('Unknown');
    }

    if (this.options.refocusAfterSuccess) {
      // refocus on the window
      // @ts-ignore
      BW.getAllWindows().filter(w => w.isVisible()).forEach(w => w.show());
    }

    return parsed.query.code as string
  }

  /**
   * Get Google tokens for given scopes
   * @param {boolean} forceAddSession
   * @returns {Promise<Credentials>}
   */
  openAuthWindowAndGetTokens(forceAddSession: boolean = false) {
    return this
      .getAuthorizationCode(forceAddSession)
      .then((authorizationCode) => {
        return this.oauth2Client
          .getToken(authorizationCode)
          .then(response => {
            this.oauth2Client.setCredentials(response.tokens);
            return response.tokens;
          });
      });
  }

  setTokens(tokens: Credentials) {
    this.oauth2Client.setCredentials(tokens);
  }
}
