// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Dev-only route /-/next/dev/hydrate?n=10000,50000: runs the data-layer
// benchmark (bench/hydrate.ts) and shows the numbers; e2e/hydrate.bench.spec.ts
// reads them from window.__bench.

import {useEffect, useState} from 'react';
import {CenteredScreen} from '../../app/LoggedOut.tsx';
import {EmptyState} from '../../ui/index.ts';
import {Gauge} from 'lucide-react';
import {type BenchResult, benchHydrate} from './hydrate.ts';

declare global {
  interface Window {
    __bench?: BenchResult[] | {error: string};
  }
}

// StrictMode runs effects twice in development: run the benchmark once per page.
let started = false;

export default function HydrateBench() {
  const [text, setText] = useState('running…');
  useEffect(() => {
    if (started) return;
    started = true;
    const sizes = (new URLSearchParams(location.search).get('n') ?? '10000,50000').split(',').map(Number).filter((n) => n > 0);
    void (async () => {
      const out: BenchResult[] = [];
      try {
        for (const n of sizes) out.push(await benchHydrate(n));
        window.__bench = out;
        setText(out.map((r) => Object.entries(r).map(([k, v]) => `${k}=${typeof v === 'number' ? Math.round(v * 10) / 10 : String(v)}`).join(' ')).join('\n'));
      } catch (err) {
        window.__bench = {error: String(err)};
        setText(String(err));
      }
    })();
  }, []);
  return (
    <CenteredScreen>
      <EmptyState icon={Gauge} title="Data layer benchmark" description={text}/>
    </CenteredScreen>
  );
}
