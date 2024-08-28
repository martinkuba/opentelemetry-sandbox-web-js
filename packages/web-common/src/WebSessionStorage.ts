
/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Session } from "./types/Session";
import { SessionStorage } from "./types/SessionStorage";

const SESSION_STORAGE_KEY = 'opentelemetry-session';

export class WebSessionStorage implements SessionStorage {
  save(session: Session): void {
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  }

  get(): Session | null {
    const sessionData = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (sessionData) {
        return JSON.parse(sessionData) as Session;
    }
    return null;
  }
}