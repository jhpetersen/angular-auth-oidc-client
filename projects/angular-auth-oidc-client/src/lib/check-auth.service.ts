import { Injectable } from '@angular/core';
import { forkJoin, Observable, of, throwError } from 'rxjs';
import { catchError, map, switchMap, tap } from 'rxjs/operators';
import { AuthStateService } from './auth-state/auth-state.service';
import { AutoLoginService } from './auto-login/auto-login.service';
import { CallbackService } from './callback/callback.service';
import { PeriodicallyTokenCheckService } from './callback/periodically-token-check.service';
import { RefreshSessionService } from './callback/refresh-session.service';
import { OpenIdConfiguration } from './config/openid-configuration';
import { CheckSessionService } from './iframe/check-session.service';
import { SilentRenewService } from './iframe/silent-renew.service';
import { LoggerService } from './logging/logger.service';
import { LoginResponse } from './login/login-response';
import { PopUpService } from './login/popup/popup.service';
import { StoragePersistenceService } from './storage/storage-persistence.service';
import { UserService } from './user-data/user.service';
import { CurrentUrlService } from './utils/url/current-url.service';

@Injectable()
export class CheckAuthService {
  constructor(
    private checkSessionService: CheckSessionService,
    private currentUrlService: CurrentUrlService,
    private silentRenewService: SilentRenewService,
    private userService: UserService,
    private loggerService: LoggerService,
    private authStateService: AuthStateService,
    private callbackService: CallbackService,
    private refreshSessionService: RefreshSessionService,
    private periodicallyTokenCheckService: PeriodicallyTokenCheckService,
    private popupService: PopUpService,
    private autoLoginService: AutoLoginService,
    private storagePersistenceService: StoragePersistenceService
  ) {}

  checkAuth(configuration: OpenIdConfiguration, url?: string): Observable<LoginResponse> {
    if (this.currentUrlService.currentUrlHasStateParam()) {
      const stateParamFromUrl = this.currentUrlService.getStateParamFromCurrentUrl();
      const config = this.getConfigurationWithUrlState([configuration], stateParamFromUrl);

      if (!config) {
        return throwError(() => new Error(`could not find matching config for state ${stateParamFromUrl}`));
      }

      return this.checkAuthWithConfig(config, url);
    }

    return this.checkAuthWithConfig(configuration, url);
  }

  checkAuthMultiple(configurations: OpenIdConfiguration[], url?: string): Observable<LoginResponse[]> {
    if (this.currentUrlService.currentUrlHasStateParam()) {
      const stateParamFromUrl = this.currentUrlService.getStateParamFromCurrentUrl();
      const config = this.getConfigurationWithUrlState(configurations, stateParamFromUrl);

      if (!config) {
        return throwError(() => new Error(`could not find matching config for state ${stateParamFromUrl}`));
      }

      return this.composeMultipleLoginResults(configurations, config, url);
    }

    const allChecks$ = configurations.map((x) => this.checkAuthWithConfig(x, url));

    return forkJoin(allChecks$);
  }

  checkAuthIncludingServer(configuration: OpenIdConfiguration): Observable<LoginResponse> {
    return this.checkAuthWithConfig(configuration).pipe(
      switchMap((loginResponse) => {
        const { isAuthenticated } = loginResponse;
        const { configId } = configuration;

        if (isAuthenticated) {
          return of(loginResponse);
        }

        return this.refreshSessionService.forceRefreshSession(configId).pipe(
          tap((loginResponseAfterRefreshSession) => {
            if (loginResponseAfterRefreshSession?.isAuthenticated) {
              this.startCheckSessionAndValidation(configId);
            }
          })
        );
      })
    );
  }

  private checkAuthWithConfig(config: OpenIdConfiguration, url?: string): Observable<LoginResponse> {
    const { configId, authority } = config;

    if (!config) {
      const errorMessage = 'Please provide at least one configuration before setting up the module';
      this.loggerService.logError(configId, errorMessage);

      return of({ isAuthenticated: false, errorMessage, userData: null, idToken: null, accessToken: null, configId });
    }

    const currentUrl = url || this.currentUrlService.getCurrentUrl();

    this.loggerService.logDebug(configId, `Working with config '${configId}' using ${authority}`);

    if (this.popupService.isCurrentlyInPopup()) {
      this.popupService.sendMessageToMainWindow(currentUrl);

      return of(null);
    }

    const isCallback = this.callbackService.isCallback(currentUrl);

    this.loggerService.logDebug(configId, 'currentUrl to check auth with: ', currentUrl);

    const callback$ = isCallback ? this.callbackService.handleCallbackAndFireEvents(currentUrl, configId) : of(null);

    return callback$.pipe(
      map(() => {
        const isAuthenticated = this.authStateService.areAuthStorageTokensValid(configId);
        if (isAuthenticated) {
          this.startCheckSessionAndValidation(configId);

          if (!isCallback) {
            this.authStateService.setAuthenticatedAndFireEvent();
            this.userService.publishUserDataIfExists(configId);
          }
        }

        this.loggerService.logDebug(configId, 'checkAuth completed - firing events now. isAuthenticated: ' + isAuthenticated);

        return {
          isAuthenticated,
          userData: this.userService.getUserDataFromStore(configId),
          accessToken: this.authStateService.getAccessToken(configId),
          idToken: this.authStateService.getIdToken(configId),
          configId,
        };
      }),
      tap(({ isAuthenticated }) => {
        if (isAuthenticated) {
          this.autoLoginService.checkSavedRedirectRouteAndNavigate(configId);
        }
      }),
      catchError(({ message }) => {
        this.loggerService.logError(configId, message);

        return of({ isAuthenticated: false, errorMessage: message, userData: null, idToken: null, accessToken: null, configId });
      })
    );
  }

  private startCheckSessionAndValidation(configId: string): void {
    if (this.checkSessionService.isCheckSessionConfigured(configId)) {
      this.checkSessionService.start(configId);
    }

    this.periodicallyTokenCheckService.startTokenValidationPeriodically();

    if (this.silentRenewService.isSilentRenewConfigured(configId)) {
      this.silentRenewService.getOrCreateIframe(configId);
    }
  }

  private getConfigurationWithUrlState(configurations: OpenIdConfiguration[], stateFromUrl: string): OpenIdConfiguration {
    for (const config of configurations) {
      const storedState = this.storagePersistenceService.read('authStateControl', config.configId);

      if (storedState === stateFromUrl) {
        return config;
      }
    }

    return null;
  }

  private composeMultipleLoginResults(
    configurations: OpenIdConfiguration[],
    activeConfig: OpenIdConfiguration,
    url?: string
  ): Observable<LoginResponse[]> {
    const allOtherConfigs = configurations.filter((x) => x.configId !== activeConfig.configId);

    const currentConfigResult = this.checkAuthWithConfig(activeConfig, url);

    const allOtherConfigResults = allOtherConfigs.map((config) => {
      const { redirectUrl } = config;

      return this.checkAuthWithConfig(config, redirectUrl);
    });

    return forkJoin([currentConfigResult, ...allOtherConfigResults]);
  }
}
