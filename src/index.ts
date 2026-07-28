import type { API } from 'homebridge';

import { PLATFORM_NAME } from './settings';
import { UnifiProtectPlatform } from './platform';

export = (api: API): void => {
  api.registerPlatform(PLATFORM_NAME, UnifiProtectPlatform);
};
