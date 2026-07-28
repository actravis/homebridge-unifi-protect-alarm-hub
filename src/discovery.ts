// Pure accessory-discovery decision: given a hub snapshot + config, decide which HomeKit
// accessories should exist. No Homebridge/HAP, no side effects — so the dynamic-discovery
// rules (which zones/outputs appear, how they're named) are unit-testable directly. The
// platform maps these plans to real accessories and reconciles them.

import type { AlarmHub } from './types';
import { isKnownZoneType, zoneKindFor, type ZoneKind } from './zones';

export type PlannedKind = 'security' | 'hub' | 'zone' | 'output' | 'emergency';

export interface PlannedAccessory {
  /** Stable identity suffix (combined with the hub MAC to form the accessory UUID). */
  key: string;
  name: string;
  category: 'security' | 'sensor';
  kind: PlannedKind;
  channel?: string; // zone / output
  zoneKind?: ZoneKind; // zone only
}

export interface PlanConfig {
  securityName?: string;
  glassBreakAs?: 'contact' | 'motion';
  exposeOutputs?: boolean;
  exposeEmergencyInput?: boolean;
}

/**
 * Plan the accessory set for a hub snapshot. Enabled+typed input channels and enabled outputs
 * appear; disabling one in UniFi drops it from the next plan (that's how prune-on-disable
 * works). `unknownTypes` collects input types we didn't recognise (mapped to contact), so the
 * caller can warn about them once.
 */
export function planAccessories(
  hub: AlarmHub,
  config: PlanConfig,
): { accessories: PlannedAccessory[]; unknownTypes: string[] } {
  const accessories: PlannedAccessory[] = [];
  const unknownTypes: string[] = [];

  accessories.push({
    key: 'security',
    name: config.securityName?.trim() || 'Security System',
    category: 'security',
    kind: 'security',
  });
  accessories.push({ key: 'hub', name: hub.name, category: 'sensor', kind: 'hub' });

  for (const [channel, input] of Object.entries(hub.alarmHub?.input ?? {})) {
    if (input.enable !== 'on' || !input.inputType) {
      continue; // only enabled, typed terminals
    }
    if (!isKnownZoneType(input.inputType) && !unknownTypes.includes(input.inputType)) {
      unknownTypes.push(input.inputType);
    }
    const zoneKind = zoneKindFor(input.inputType, config.glassBreakAs);
    accessories.push({
      // Kind is part of the identity so a terminal's type change re-creates cleanly.
      key: `zone:${channel}:${zoneKind}`,
      name: input.name ?? `${input.inputType} ${Number(channel) + 1}`,
      category: 'sensor',
      kind: 'zone',
      channel,
      zoneKind,
    });
  }

  if (config.exposeOutputs !== false) {
    for (const [channel, output] of Object.entries(hub.alarmHub?.output ?? {})) {
      if (output.enable !== 'on') {
        continue;
      }
      accessories.push({
        key: `output:${channel}`,
        name: output.name ?? `Output ${Number(channel) + 1}`,
        category: 'sensor',
        kind: 'output',
        channel,
      });
    }
  }

  if (config.exposeEmergencyInput !== false) {
    accessories.push({ key: 'emergency', name: 'Emergency Input', category: 'sensor', kind: 'emergency' });
  }

  return { accessories, unknownTypes };
}
