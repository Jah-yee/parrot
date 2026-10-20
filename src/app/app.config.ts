import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { Engine, IN_APP } from './core/engine';
import { HttpEngine } from './core/http-engine';
import { TauriEngine } from './core/tauri-engine';

export const appConfig: ApplicationConfig = {
  providers: [provideBrowserGlobalErrorListeners(), { provide: Engine, useClass: IN_APP ? TauriEngine : HttpEngine }],
};
