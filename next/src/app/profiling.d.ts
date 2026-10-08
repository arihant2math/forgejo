// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// react-dom/profiling has the API of react-dom/client (@types/react-dom has no entry for it).
declare module 'react-dom/profiling' {
  export * from 'react-dom/client';
}
