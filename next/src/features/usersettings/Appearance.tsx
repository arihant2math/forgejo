// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {ActionList, ActionMenu, SegmentedControl} from '@primer/react';
import {observer} from 'mobx-react-lite';
import {useOfflineReason} from '../../app/online.ts';
import type {ThemePreference} from '../../app/splash.ts';
import {setThemePreference, themeState} from '../../app/theme.ts';
import {ListSkeleton} from '../../components/ListSkeleton.tsx';
import {LoadState} from '../../components/LoadState.tsx';
import type {APIOption} from '../../protocol/types.gen.ts';
import {
useUserSettings
} from './data.ts';
import {FormSection, SettingRow} from './form.tsx';
import {
diffStyleOf
} from './payload.ts';
import {Toggle, useChange} from './SettingsParts.tsx';

const NEXT_THEMES: {value: ThemePreference; label: string}[] = [
  {value: 'system', label: 'System'},
  {value: 'light', label: 'Light'},
  {value: 'dark', label: 'Dark'},
];

export const AppearanceView = observer(function AppearanceView() {
  const settingsRes = useUserSettings('settings');
  const optionsRes = useUserSettings('options');
  const settings = settingsRes.value;
  const options = optionsRes.value;
  const change = useChange(settingsRes);
  const offline = useOfflineReason('Changing the appearance');
  return (
    <>
      <FormSection title="Forgejo Next" description="How this app looks on this device.">
        <SettingRow title="Theme" description="System follows your device's light or dark mode.">
          <SegmentedControl size="small" aria-label="Theme" onChange={(index) => {
            const theme = NEXT_THEMES[index ?? -1];
            if (theme) setThemePreference(theme.value);
          }}>{NEXT_THEMES.map((theme) => <SegmentedControl.Button key={theme.value} selected={themeState.preference === theme.value}>{theme.label}</SegmentedControl.Button>)}</SegmentedControl>
        </SettingRow>
      </FormSection>
      <FormSection title="Your account" description="Saved with your account: the classic UI and Forgejo's emails use them.">
        {settings && options ? (
          <>
            <SettingRow title="Language" description="Of the classic UI and the emails Forgejo sends you.">
              <ChoiceMenu label="Language" value={settings.language} options={options.languages} fallback="Default" disabled={offline} onChange={(v) => {
                change({language: v}, 'Language');
              }}/>
            </SettingRow>
            <SettingRow title="Classic UI theme">
              <ChoiceMenu label="Classic UI theme" value={settings.theme || options.default_theme} options={options.themes} disabled={offline} onChange={(v) => {
                change({theme: v}, 'Theme');
              }}/>
            </SettingRow>
            <SettingRow title="Diff view" description="How the classic UI shows a change.">
              {offline ? <span className="text-sm text-muted">{diffStyleOf(settings.diff_view_style) === 'split' ? 'Split' : 'Unified'}</span> :
                <SegmentedControl size="small" aria-label="Diff view" onChange={(index) => {
                  if (index !== undefined) change({diff_view_style: index === 0 ? 'unified' : 'split'}, 'Diff view');
                }}><SegmentedControl.Button selected={diffStyleOf(settings.diff_view_style) === 'unified'}>Unified</SegmentedControl.Button><SegmentedControl.Button selected={diffStyleOf(settings.diff_view_style) === 'split'}>Split</SegmentedControl.Button></SegmentedControl>}
            </SettingRow>
            <Toggle res={settingsRes} settings={settings} field="enable_repo_unit_hints" label="Hints for a repository's unused features"
              hint="The classic UI suggests adding what a repository you own does not use yet (a wiki, releases)." offline={offline}/>
            {offline && <p className="text-sm text-muted">{offline}</p>}
          </>
        ) : <LoadState res={settings ? optionsRes : settingsRes} what="Your appearance settings" skeleton={<ListSkeleton rows={4} lines={1} leading="none"/>}/>}
      </FormSection>
    </>
  );
});

function ChoiceMenu({label, value, options, fallback, disabled, onChange}: {
  label: string; value: string; options: APIOption[]; fallback?: string; disabled: string | undefined; onChange: (v: string) => void;
}) {
  const name = options.find((o) => o.id === value)?.name ?? (value !== '' ? value : fallback ?? '—');
  return (
    <ActionMenu>
      <ActionMenu.Button size="small" aria-label={`${label}: ${name}`} inactive={Boolean(disabled)}>{name}</ActionMenu.Button>
      <ActionMenu.Overlay align="end"><ActionList>
        <ActionList.Group selectionVariant="single">
          {options.map((o) => <ActionList.Item key={o.id} selected={value === o.id} onSelect={() => {
            if (o.id !== value) onChange(o.id);
          }}>{o.name}</ActionList.Item>)}
        </ActionList.Group>
      </ActionList></ActionMenu.Overlay>
    </ActionMenu>
  );
}
