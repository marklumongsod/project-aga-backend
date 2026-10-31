# Project AGA: Frontend requirements

> Spec for building the Project AGA web app on top of the existing backend (`project-aga-backend`, NestJS, `/api/v1`).
> The approved screens are in `docs/design-reference/*.html`. Open them in a browser and match them.
> Every response sample below was captured from the running API with the seeded demo data.

---

## 1. What we are building

One web app with two faces:

1. **TESDA office dashboard** (sign-in required) for three roles:
   - **CO**, Central Office: the whole country
   - **RO**, Regional Office: one region
   - **PO**, Provincial Office: one province

   It shows which cities have no assessment center within reach ("assessment deserts"), how many candidates are flagged because of that, and lets offices drop a proposed new center on the map to see which deserts it closes. The travel limit (90 minutes by default) can be changed from the dashboard. There is no capacity model: center slots are not counted.
2. **Public Assessment Center Finder** (no sign-in) for learners. They search their city or use their current location, filter by qualification and area, and get the nearest assessment centers by travel time.

There are **no other roles**. Don't build user management or registration. Accounts come from T2MIS.

## 2. Recommended stack

The backend doesn't force any of this. If you change something, say so in the frontend README.

| Concern | Choice | Why |
| --- | --- | --- |
| Build | **Vite + React 18 + TypeScript (strict)** | Backend CORS default is `http://localhost:5173` (Vite) |
| Routing | React Router 6 (data routers) | Role-based route guards |
| Server state | TanStack Query 5 | Caching per `level/code`, retries, loading states |
| Map | **MapLibre GL JS** (+ `react-map-gl/maplibre` optional) | GeoJSON choropleth, circle layers, draggable marker, no API key |
| Basemap | Muted vector style, e.g. OpenFreeMap "positron"; or no basemap (choropleth on a light sea color, as in the designs) | OSM's own tile servers are not for production apps |
| Forms | React Hook Form + Zod | Mirrors the backend validation |
| Styling | CSS variables from §9 + CSS Modules or Tailwind configured with the same tokens | Must match the design reference |
| Tests | Vitest + Testing Library; Playwright for the 4 key flows in §12 | |
| API types | Generate from Swagger: `npx openapi-typescript http://localhost:3000/docs-json -o src/api/schema.d.ts` | Single source of truth. Regenerate when the API changes |

Environment: `VITE_API_URL=http://localhost:3000/api/v1`.

## 3. Routes

| Path | Who | Screen (design reference) |
| --- | --- | --- |
| `/` | public | Public Finder (`7-public-finder.html`, `8-public-finder-desert.html`) |
| `/login` | public | Office sign-in (`1-sign-in.html`) |
| `/dashboard` | CO, RO, PO | Home area overview. Lands on the user's own area (see §5) |
| `/dashboard/:level/:code` | CO, RO, PO | Drill-down (level = `region` \| `province`). Scope-checked |
| `/plan` | CO, RO, PO | Plan a new center / drag-and-drop what-if (`6-po-drop-pin.html`). Optional `?level=province&code=<psgc>` (plan inside that area) and `?pin=lat,lon` (open with a pin placed) |
| `/proposals` | CO, RO, PO | Saved proposals: list, open in the planner, export PDF, delete |
| `/reports` | CO, RO, PO | Placeholder page ("Coming soon"). No API yet |

Route guard: if there's no token, go to `/login?next=…`. If the role isn't allowed, show 403 and a link back to `/dashboard`. Keep state in the URL (`tab`, `level`, `code`, selected center) so links can be shared.

## 4. Authentication

**`POST /auth/login`** `{ email, password }` → `200`

```json
{
  "accessToken": "eyJ…",
  "tokenType": "Bearer",
  "expiresIn": 28800,
  "user": {
    "id": "1d098100-…", "email": "po.negrosoccidental@demo.aga.local",
    "name": "Provincial Office Negros Occidental (demo)",
    "role": "PO", "regionPsgc": "0600000000", "provincePsgc": "0604500000"
  }
}
```

- `401` = wrong email or password. Show "Email or password is incorrect" and don't say which.
- `429` = rate limited (10 per minute on login). Show "Too many attempts, try again in a minute".
- Send `Authorization: Bearer <token>` on every non-public call. There is no refresh token. The token lasts 8 h.
- Keep the token in memory, mirrored to `sessionStorage` so it survives a page reload. Only when the user ticks **Keep me signed in on this device** is it kept in `localStorage` instead, so it survives closing the browser; it still expires after 8 hours, and signing out or a `401` removes it from both. On any `401` from the API, clear it and redirect to `/login?next=…` with "Your session ended, please sign in again".
- On app load with a stored token, call **`GET /auth/me`** to restore the user.
- **"Continue with TESDA SSO (T2MIS)"**: show the button as in the design. `POST /auth/sso/t2mis` returns `501` until T2MIS is configured. Show "TESDA SSO isn't connected yet. Use your email for now."
- "Forgot password?" and "No account?" are informational only: accounts and passwords are managed in T2MIS.
- Sign out: clear the token and go to `/login`.

**Sign-in screen** (two columns; the mockup is the reference): a navy brand panel on the left (seal and name, a map of the Philippines with some deserts in red, "Know which provinces can't assess their candidates.", three bullets, "For TESDA Central, Regional, Provincial and District offices.") and the form on the right. Right side, top to bottom: "Looking for an assessment center? Use the public finder →" (link to `/`), the eyebrow "TESDA offices", "Sign in to Project AGA", "Use the same account you use for T2MIS.", the SSO button, "or sign in with email", Email (placeholder `name@tesda.gov.ph`), Password (placeholder "Enter your password", an eye button to show or hide it, and a "Forgot password?" link that goes to the note below), the **Keep me signed in on this device** checkbox, an outlined **Sign in** button, a note "Accounts and passwords are managed in T2MIS. For access or a password reset, contact your office's T2MIS administrator.", and "Authorized TESDA personnel only. Activity is logged." at the bottom. Below 860 px the brand panel stacks above the form and the map is hidden.

Demo accounts (password = `SEED_DEMO_PASSWORD` from the backend `.env`):
- `co.planning@demo.aga.local`
- `ro.region6@demo.aga.local`
- `po.negrosoccidental@demo.aga.local`

## 5. Roles and what each one sees

| | CO | RO | PO |
| --- | --- | --- | --- |
| Lands on | Philippines | own region | own province |
| Map and table show | regions of the PH (17) | provinces in region | cities and municipalities in province |
| Top list | Top 5 regions | Top 3 provinces | Top 3 cities/municipalities ("assessment deserts") |
| Can drill into | any region, any province | own region's provinces | (none, already at province) |
| Nav | Dashboard · Plan a center · Proposals · Reports | Dashboard · Reports | Dashboard · Reports |
| What-if pin | anywhere on land | inside own region | inside own province |
| Header badge | `CO · CENTRAL OFFICE` | `RO · REGIONAL OFFICE` | `PO · PROVINCIAL OFFICE` |

The backend enforces all of this (`403 "This area is outside your office scope"`). The UI must also hide what a role can't use. Don't show disabled controls for other roles' features. RO and PO screens show a footnote: "Figures outside <area> are hidden for this account."

Area names for the header: the region name and province name come from `/geo/regions` and `/geo/regions/:psgc/provinces`, matched by `user.regionPsgc` and `user.provincePsgc`.

## 6. Office dashboard (CO / RO / PO)

Design: `2-co-overview.html`, `4-ro-region6-hover.html`, `5-po-negros-center-reach.html`.

### 6.1 Layout (top to bottom)

1. **Gov strip**: "Republic of the Philippines · Technical Education and Skills Development Authority". On the right: the office name. Below it, a 3-px tricolor bar (blue `#0b2a7a` / red `#ce1126` / yellow `#fcd116`).
2. **App header** (navy `#0c1f40`): AGA seal + "Project AGA / Assessment Center Gap Analysis", nav, role badge (gold), office name + area, Sign out.
3. **No visible title or breadcrumb.** The page shows no "<Area> · Simulation run <date>" line and no headline sentence. Keep one visually hidden `<h1>` with the area name for screen readers. Going back up is done with the back buttons in §6.1 item 4 and the Area pickers in the filter bar.
4. **Back buttons** (drill-downs only, above the tabs): CO sees "← All regions" (to `/dashboard`) and, inside a province, "← <region name>"; RO sees "← <own region name>" inside a province; PO has none.
5. **No tabs.** There is no Insights or next-quarter view; the dashboard is the one Overview screen.
6. **Filter bar**:
   - **Area**: CO picks from regions → provinces; RO picks its provinces; PO has no picker.
   - **Qualification**: "All qualifications". Disabled with a tooltip "Per-qualification results need course-level data", because the backend can't simulate per qualification yet.
   - **Travel limit**: a slider from 10 minutes to 3 hours (180 minutes, default 90). It sets `?limitMinutes=` on the dashboard, center and what-if calls, and `?limit=45` in the page URL so a view can be shared. The server runs the check for that limit (kept for 30 minutes, not saved to history). Show "Recalculating…" while it loads and a reset button when the value isn't the default.
7. **KPI row** (4 cards), from `GET /dashboard/overview`:

   | Card | Value | Sub-line |
   | --- | --- | --- |
   | Candidates waiting | `area.candidates` | "completed training, not yet assessed" |
   | Flagged | `area.flagged` + `flaggedShare` as % | "No center within {limitMinutes} minutes" |
   | Assessment deserts | `deserts.cities` | "{deserts.candidates} candidates with no center in reach" |
   | Assessment centers | `area.centers` | "in the analysis" (national) or "in this area" |

8. **Map card** (left, about 60%) + **Top list** (right).
9. **All-areas table** under the map: every child area (`rows`), sortable by Candidates, Centers, Flagged, Desert. Default sort is worst first (API order = `rank`). Filters above the table: **Desert** (All, Any desert, Level 4 to 1, No desert) and a name search, with "Showing n of m" and a Clear button. A province or region matches a level when the highest level among its cities is that level.
10. **No sources panel or footnote.** The page does not list its sources; the run date is not shown either.

### 6.2 `GET /dashboard/overview?level=&code=&limitMinutes=`

All parameters are optional. Omit them to get the user's home area. `level` is `NATIONAL` \| `REGION` \| `PROVINCE`; `code` is a 10-digit PSGC.

```json
{
  "run": { "id": "539a…", "finishedAt": 1793327052,
           "assumptions": { "travel": "osrm(road+ferry matrix, 109301 pairs, …)",
                            "limitMinutes": 90,
                            "candidates": "BSRS completed per city (…)",
                            "centers": "assessment centers listed by the TESDA Assessor Coverage API (synced nightly)" } },
  "area": { "level": "PROVINCE", "code": "0604500000", "name": "Negros Occidental", "parentCode": "0600000000",
            "candidates": 35185, "flagged": 5675, "served": 29510, "flaggedShare": 0.161, "serviceRate": 0.8387,
            "centers": 40, "densityBand": 0, "desertLevel": 4, "desertCities": 5, "desertCandidates": 5675,
            "estimatedCandidates": 0, "nearestMinutes": null },
  "childLevel": "CITY",
  "top":  [ { "level": "CITY", "code": "0604506000", "name": "Candoni", "candidates": 1135,
              "flagged": 1135, "served": 0, "flaggedShare": 1, "serviceRate": 0, "centers": 0, "densityBand": 0,
              "desertLevel": 4, "desertCities": 1, "desertCandidates": 1135,
              "estimatedCandidates": 1135, "nearestMinutes": null, "rank": 1 } ],
  "rows": [ /* every child area, same shape, worst first */ ],
  "deserts": { "cities": 5, "candidates": 5675,
               "byLevel": [ { "level": 4, "label": "Level 4: more than 60 candidates", "cities": 5, "candidates": 5675 } ] },
  "desertLegend": [ { "band": 0, "label": "Not an assessment desert", "color": "#e6e9f0" }, … ],
  "densityLegend": [ { "band": 0, "label": "…", "color": "#…" }, … ]
}
```

Rules:
- **`parentCode`** is what an area sits in (a province's region, a city's province; `null` for a region or the country). Use it to fill the Region and Province pickers and the back buttons when the link has no `?region=`.
- **Shares are fractions** (`0.161` = 16.1%). `flaggedShare` and `serviceRate` always show one decimal. `centers: 0` means the area has no center of its own → show "No center" (PO Top 3 "Status" column).
- **The service rate is reach-based access**, not capacity: `serviceRate = (candidates - flagged) / candidates`. There is **no utilization rate, slot count, "centers full" or candidates-to-slots ratio** anywhere in the API. Don't build them.
- Every `limitMinutes` request (`?limitMinutes=`, 10 to 180) returns the same shape; `run.assumptions.limitMinutes` is the limit that was used. Anything outside 10 to 300, or not a whole number, is `400`.
- Flagged candidates are exactly the candidates in desert cities (no center in reach), so `flagged` equals `desertCandidates` at every level.
- `top` is already Top 5 regions (national) or Top 3 provinces/cities (region/province), worst first. Don't re-rank. Read each item's `level` for the title.
- `404 "No completed simulation yet…"` → empty state: "No simulation has run yet." The backend runs daily at 2:00 AM Asia/Manila, so there is no button to start one.

### 6.3 Map: `GET /dashboard/map?level=&code=&limitMinutes=`

Returns a GeoJSON `FeatureCollection` (about 250 KB at national level):

```json
{ "type": "FeatureCollection",
  "properties": { "area": { "level": "PROVINCE", "code": "0604500000", "name": "Negros Occidental" },
                  "childLevel": "CITY", "runId": "539a…", "desertLegend": [ … ], "densityLegend": [ … ] },
  "features": [ { "type": "Feature", "id": "0604502000", "geometry": { … },
                  "properties": { "level": "CITY", "code": "0604502000", "name": "City of Bago",
                                  "candidates": 1135, "flagged": 0, "flaggedShare": 0, "centers": 11,
                                  "densityBand": 0, "desertLevel": 0, "desertCities": 0, "desertCandidates": 0,
                                  "estimatedCandidates": 1135, "nearestMinutes": 21.2, "rank": 6 } } ] }
```

- **Fill color**: the API has no single `band`. The frontend sets the fill band from the map view: `desertLevel` (0-4) with `desertLegend`, or `densityBand` with `densityLegend`. Use a MapLibre `match` expression built from the legend. Never hard-code colors in the frontend. The default view is deserts.
- **Legend** under the map: the named classes of the current view as swatches, with one line of explanation (a desert is a city with candidates and no center within the travel limit).
- **Top-N numbering**: put a numbered navy badge (1–5 / 1–3) at the label point of each `top` area.
- **Hover** an area: tooltip with name, flagged %, candidates, and the desert level when it is one.
- **Click** an area (CO, RO): drill down to `/dashboard/<childLevel>/<code>`. PO areas are cities and can't be drilled into; a click selects the row in the table.
- Fit bounds to the features on load. Thin white borders (0.6 px); 2 px navy outline on hover or selection.
- At national level the map shows the 17 regions; keep fills light.

### 6.4 Centers on the map: `GET /dashboard/centers?level=&code=&limitMinutes=`

```json
[ { "id": 1974, "name": "GOLDEN PRIME INSTITUTE FOR TECHNOLOGY SERVICES INC.",
    "city": "Valladolid", "lat": 10.446, "lon": 122.827,
    "predictedCandidates": 11350 } ]
```

- Draw centers as small dots (circle layer, navy with a white stroke) on RO and PO maps. At national level (about 2,400 centers), show them only from zoom ≥ 7 or behind a "Show centers" toggle.
- **Hover a center** → floating card (`4-ro-region6-hover.html`):
  - name and city
  - **Predicted candidates** `predictedCandidates`
  - tag "TESDA offices only"

  Keep the card inside the map; flip it to the left of the dot near the right edge.
- Center names in T2MIS are often ALL CAPS. Display them in Title Case (keep acronyms such as `TESDA`, `NC`, `II` as they are).

### 6.5 Selected center + 90-minute reach

Design: `5-po-negros-center-reach.html`.

Click a center → `GET /centers/:id` + `GET /centers/:id/reach`.

`GET /centers/:id`:

```json
{ "id": 2782, "name": "…", "address": "Purok 5, Barangay Alangilan, …", "phone": "(034)433-0362/474-3566",
  "email": null, "website": null, "accreditedUntil": 1810483200, "listedByTesda": true,
  "lat": 10.67, "lon": 123.07, "city": "City of Talisay", "province": "Negros Occidental",
  "region": "Region VI (Western Visayas)", "coordStatus": "validated", "includeInAnalysis": true,
  "qualifications": [ { "id": 241, "title": "Cookery NC II", "code": "TRSCOK220", "expiresAt": 1810483200 } ],
  "current": { "predictedCandidates": 11350 } }
```

`GET /centers/:id/reach` → `FeatureCollection` of cities:
- `properties`: `{ center, limitMinutes, travelModel, citiesWithinLimit }`
- each feature: `{ key, name, km, minutes, withinLimit, isoBand }`

On the map:
- Fade the area fill to about 30% and paint reach cities by `isoBand`: 0 = ≤30 min, 1 = ≤60, 2 = ≤90 (greens, darkest closest). Bands 3–4 (beyond the limit) stay faded.
- Draw a dashed outline around the union of `withinLimit` cities ("90-minute area").
- Reach can cross the province border (e.g. "+ 5 in Negros Oriental"). Show those too, grouped as "+ N in <province>".
- Legend switches to "Travel time to the selected center: ≤ 30 · ≤ 60 · ≤ 90 min · - - - 90-minute area · Other areas are faded".
- "✕ Clear selection" restores the normal map.

Side panel "Selected center":
- name, city · "T2MIS center {id}"
- Predicted candidates, "Within {limit} min: {citiesWithinLimit} cities and municipalities"
- a two-column list **Reaches · Travel** sorted by minutes
- If `qualifications` is empty: "Qualifications: no program data for this center in T2MIS yet."

### 6.6 Error and empty states (all dashboard calls)

| Case | UI |
| --- | --- |
| loading | skeletons for KPI cards, map and table (not spinners over the whole page) |
| 401 | sign out → `/login` |
| 403 | "This area is outside your office scope", with a link to the home area |
| 404 no run | "No simulation has run yet" (the daily run fills it in) |
| network / 5xx | inline error card with Retry; keep the last good data visible |

## 7. Plan a new center (drag-and-drop what-if)

Design: `6-po-drop-pin.html`. Every role, limited to its own scope.

Entry points: the "Drag a new center onto the map" chip (with a location-pin icon) on the dashboard map, and the "Plan a new center" button (also with the pin icon) under the Top list. Both open the planner **on the area being viewed**: from a province or region drill-down the link is `/plan?level=province&code=<psgc>` (or `level=region`), and from the home dashboard it is plain `/plan`. With `level` and `code` the planner map, the centers and the result all cover that one area, and a "← Back to <area>" link returns to its dashboard. An area the user may not see shows the 403 message.

1. The map shows the user's area (same choropleth as Overview) and a gold **New assessment center** chip with a location-pin icon. The user drags a plain gold location pin (teardrop with a white dot, tip on the spot) onto the map (MapLibre `Marker({ draggable: true })`). They can drag it again afterwards.
2. **The side panel fits the screen** (no long page scroll). It is a column with its own scroll and two tabs, and the proposal buttons pinned at the bottom:
   - **Recommended places** tab (the default), from `GET /simulation/recommendations?level=&code=&count=3`: a one-line summary ("N assessment deserts in <area> hold M candidates. These sites close the most, best first.") and up to three compact cards. Each card has a rank badge, the city and province, "+X candidates · closes N deserts", one muted line (the deserts it covers when more than one, otherwise "On <road name>", or "Inside the city (road not found)"), an **Offer first** line of up to three qualification chips from `topQualifications` (name and `~estimatedCandidates`; a chip is amber when `centersOffering` is 0, and its tooltip says how many candidates, the share, and how many centers already offer it), and a **Place pin** button. `qualificationSource` is shown under the cards. The figures are estimates: the province's graduate mix applied to the candidates the site serves. The same sites appear on the map as numbered gold markers; clicking a marker or the button puts the pin there, flies the map to it and runs the what-if. The card of the site the pin is on is highlighted. With no deserts the tab says "<area> has no assessment deserts, so no new center is needed." A failed request hides the cards (the planner still works by dragging).
   - **If this center opens** tab (disabled until a pin is placed; the panel switches to it by itself when the first pin is placed, and back to the first tab when the pin is removed): the site name and coordinates on one line; **Newly served** and **Deserts closed** side by side; **Flagged in <area>** with the new share large and "was x% · n left"; a small **Where the pin lands** table (Area, Flagged before → after, Deserts before → after, with Nationwide for Central Office); and **Places that gain the most** (3 rows, then "Show all (n more)").
   - Pinned footer (visible on both tabs once a pin is placed): the optional proposal name, **Save proposal**, **Export PDF** (and **Send to Regional Office** for PO), and a "Saved. Find it under Proposals." note.
   - The map is tall (it fills the screen height, 420 to 700 px). Below 1100 px wide the panel stacks under the map without its own scroll.
   - There is no re-run button: the what-if runs by itself every time the pin is placed, moved or dragged, debounced 400 ms (cancel in-flight requests with `AbortController`; show a skeleton in the result tab while it loads).
   - There is no "Place pin at map center" button and no nudge arrows, and no Qualifications select (per-qualification results are not available; the Recommended places tab says so).
3. **`POST /simulation/what-if`** `{ lat, lon, name?, level?, code?, limitMinutes? }` (`level` is `REGION` or `PROVINCE` and goes with `code`: the pin must land inside that area, otherwise `400 "Drop the new center inside <name> (on land)"`, and `area` in the result is that area; an area outside the office's scope is `403`) → `200` (a `slotsPerQuarter` field is rejected with `400`) (takes 0.2–0.5 s):

```json
{ "pin": { "lat": 9.752, "lon": 122.405, "cityKey": "0604527000", "cityName": "City of Sipalay" },
  "newlyServed": 4540, "pinDemand": 4540, "limitMinutes": 90,
  "area":     { "level": "PROVINCE", "code": "0604500000", "name": "Negros Occidental", "candidates": 35185,
                "flaggedBefore": 5675, "flaggedAfter": 1135, "flaggedShareBefore": 0.161, "flaggedShareAfter": 0.032,
                "desertCitiesBefore": 5, "desertCitiesAfter": 1 },
  "national": { "level": "NATIONAL", "code": "PH", … },
  "placeAreas": [ … ],
  "improvedCities": [ { "key": "0604506000", "name": "Candoni", "flaggedBefore": 1135, "flaggedAfter": 0 } ] }
```

4. Results panel "If this center opens":
   - **Newly served**: `+newlyServed`, "candidates now have a center in reach" (green card)
   - **Assessment deserts closed**: `desertCitiesBefore − desertCitiesAfter` of `desertCitiesBefore` in the area
   - **Flagged in <area>**: `flaggedShareAfter` %, "was {flaggedShareBefore}% · {flaggedAfter} left"
   - **Places that gain the most**: table of `improvedCities` (top 3, then "Show all"): City / municipality · Flagged before · After (green).
   - Panel heading: `pin.cityName` + "9.752° N, 122.405° E · inside your province/region".
   - For CO, also show the `national` delta.
5. No distance circle is drawn: reach is decided by road travel time, so a circle on the map would be misleading. The numbers in the results come from the road-time check.
6. Errors:
   - `400 "Drop the new center inside your office area (on land)"`: snap the marker back to its last valid position and show the message inline.
   - `400` validation: show the field messages.
7. Buttons:
   - **Remove pin** (button in the map card header, shown while a pin is placed): clears the pin and its result.
   - **Save proposal**: `POST /proposals` with the same body as the what-if (`lat`, `lon`, optional `name`, and `level`+`code` when planning inside an area). The server re-runs the what-if and stores its own result. An optional **Proposal name** field sits above the buttons (default "New center in <city>"). After saving the button reads "Proposal saved" until the pin moves, and a note links to the Proposals page.
   - **Export PDF**: builds a one or two page PDF in the browser (site, area, travel limit, newly served, deserts closed, flagged before and after, where the pin lands, the places that gain the most, and how the figures are worked out). File name `AGA-new-center-<city>-<YYYY-MM-DD>.pdf`. Nothing is uploaded.
   - **Send to Regional Office** (PO only): still no backend; shows a "coming soon" toast.
   - **Automatic road snap**: every pin dropped or dragged by hand is sent to `GET /simulation/snap?lat=&lon=&level=&code=`. If a drivable road is within 5 km and stays inside the area and the office's scope, the pin moves onto it and the note under the map says "Moved 30 m onto <road>."; otherwise it stays and the note says no road was found. Recommended places are already on a road and are not snapped again.
   - Copy under the title: "Nothing is saved until you save the proposal."

## 7b. Proposals (`/proposals`)

`GET /proposals` lists saved proposals, newest first: your own, plus those whose pin is in your region (RO) or province (PO); Central Office sees all. Table columns: Proposal (name, city, travel limit), Area, Newly served, Deserts closed, Flagged (before → after), Saved by (You, or the author and office), Saved (date), Actions. Actions: **Open** (link to `/plan?level=..&code=..&pin=lat,lon`), **Export PDF** (fetches `GET /proposals/:id` and builds the same PDF as the planner), **Delete** (author or Central Office only; asks "Delete / Keep" in place, no browser dialog). Empty state: "No proposals yet" with a button to the planner. `GET /proposals/:id` and `DELETE` answer `404` for a proposal you may not see.

## 8. Simulation runs

The frontend has **no Simulation runs page and no way to start a run**. The backend runs on its own schedule (daily at 2:00 AM Asia/Manila), and the backend has no route to start or list runs. When no run exists yet, the dashboard shows "No simulation has run yet" until the next daily run.

## 9. Public Assessment Center Finder (`/`)

Design: `7-public-finder.html` (results), `8-public-finder-desert.html` (nothing within 90 min). No sign-in, mobile-first. **No learner, candidate or flagged data appears here.**

Header: white bar, AGA seal + "TESDA Assessment Center Finder / Find where to take your National Certificate assessment", and a "TESDA office sign in" link to `/login`. Gov strip text on the right: "Public service · no sign-in needed".

Hero: "Where can I get assessed near me?" + "Search your city or use your current location. We list the closest assessment centers by travel time, by road and ferry."

### 9.1 Search form (4 fields, one row on desktop, stacked on mobile)

1. **Your location**: combobox.
   - Typing (≥ 2 chars, debounced 250 ms) → `GET /public/places?q=` → `[{ type: "CITY", key, name, province, region, lat, lon }]`. Show "Bantayan · Cebu, Region VII".
   - **Use my location** button → `navigator.geolocation.getCurrentPosition` (timeout 10 s). On success, search with `lat`/`lon`. On denial: "Location is off. Type your city instead."
2. **Qualification**: combobox → `GET /public/qualifications?q=` → `[{ id, title, code, levelId, label: "Cookery NC II", centers: 53 }]`. Show `label`. Default "Any qualification". The list comes from the TESDA API; `id` (T2MIS QualId) is **null** for about 20% of qualifications, so search with `qualification={label}`, not `qualificationId`.
3. **Region**: `GET /geo/regions` → `[{ psgc, name }]`. Default "Any region".
4. **Province**: `GET /geo/regions/:psgc/provinces`. Enabled after a region is picked.

Put the search in the URL (`?city=0702209000&q=241&region=…&province=…`, or `?lat=&lon=`) so it can be shared. Never put geolocation coordinates in the URL; keep them in memory.

### 9.2 `GET /public/centers/nearest`

Parameters: `lat`+`lon` **or** `cityKey`, plus optional `qualification` (a `label` from `/public/qualifications`; preferred), `qualificationId` (T2MIS QualId, older), `regionPsgc`, `provincePsgc`, `limit` (1–20, default 5; use 5).

```json
{ "origin": { "lat": 11.189, "lon": 123.744, "cityKey": "0702209000", "cityName": "Bantayan", "province": "Cebu", "islandId": 37 },
  "filters": { "qualificationId": null, "qualification": null, "regionPsgc": null, "provincePsgc": null },
  "limitMinutes": 90, "travelModel": "estimate(…)",
  "desert": true,
  "programData": null,
  "results": [ { "id": 1343, "name": "PROVINCIAL TRAINING CENTER - DAANBANTAYAN",
                 "address": "Guimbawi-an, Poblacion, Daanbantayan, Cebu", "phone": "(032) 437-3781",
                 "city": "Medellin", "province": "Cebu", "lat": 11.15, "lon": 124.0011,
                 "km": 28.4, "minutes": 156, "withinLimit": false, "qualifications": [],
                 "directionsUrl": "https://www.google.com/maps/dir/?api=1&origin=…&destination=…&travelmode=driving" } ] }
```

### 9.3 Results

- Result count heading: "{n} centers offer {qualification} within 90 minutes", or "Nearest centers" without a qualification. Sub-label "Nearest first".
- Each result:
  - number badge
  - **name** (Title Case)
  - travel time big and right-aligned: `minutes` → "37 min" / "2 h 36 min"; red if `!withinLimit`
  - address · `km` km (+ "· ferry" if it crosses islands, i.e. `minutes` is much larger than `km` suggests: `minutes - km*1.35/35*60 > 60`)
  - qualification chips (first 3, "+N"), with the selected one highlighted
  - **Show route on map** (in-app turn-by-turn, `GET /public/route`; only when the backend routes with OSRM) and **Get directions** (`directionsUrl`, Google Maps, new tab; labelled "Open in Google Maps" when in-app routes are available) · **Call {phone}** (`tel:` link, digits only)
- Map (right on desktop, below the list on mobile): origin as a plain red location pin (teardrop with a white dot, tip on the spot), numbered result pins, and other centers as grey dots if available.

### 9.4 Special states

| State | Condition | UI |
| --- | --- | --- |
| **Desert** | `desert: true` and `results.length > 0` | Red banner (`8-public-finder-desert.html`): "No assessment center within 90 minutes of {origin.cityName}" + "The closest centers are … about {first result time} away including the ferry. Plan for a full day and call ahead to confirm the assessment schedule before you travel." Results list subtitle: "Includes a sea crossing". |
| **No program data** | a qualification is selected and `programData.centersWithProgramData === 0` (results empty, `desert` may be true) | **Not a desert.** Info card: "We don't have qualification lists for the {centersNearby} centers near you yet. Clear the qualification filter to see the nearest centers, and call ahead to ask." + button "Show all nearby centers". |
| **Partial program data** | `programData` present and `centersWithProgramData < centersNearby` | Note under results: "Qualification lists come from TESDA. Only {centersWithProgramData} of the {centersNearby} centers nearby have them listed yet, so other nearby centers may also assess {qualification}. Call ahead to confirm schedules." |
| **At sea / abroad** | `400 "That location is outside the Philippines or at sea"` | "We couldn't place that location in the Philippines. Type your city instead." |
| **Place not found** | `places` returns `[]` | "No city or municipality matches “{q}”." Note: Bacolod City, Ormoc, Isabela City and Cotabato City are currently missing from the boundary data. Suggest the user pick a neighbouring municipality, and log it. |
| **Rate limited** | `429` | "Too many searches. Wait a minute and try again." |

Footer: "Travel times are estimates. Data: TESDA T2MIS assessment centers, PSGC 2023. No personal data is collected; your location stays on your device. © TESDA"

## 10. Design system

Brand: Philippine government / TESDA. Calm, official, legible, not flashy. **Match `docs/design-reference/` exactly.**

```css
:root {
  /* brand */
  --navy-900: #0c1f40;   /* app header, seal */
  --navy-gov: #0b2a7a;   /* gov strip, tricolor blue */
  --blue-700: #163f8e;   /* primary buttons, links, eyebrow text */
  --gold-500: #d89a00;   /* role badge, seal ring, "new center" pin, active-nav underline */
  --ph-red:   #ce1126;  --ph-yellow: #fcd116;   /* tricolor bar only */
  /* neutrals */
  --ink:      #0e1a30;   /* body text */
  --muted:    #5b6680;   /* labels, captions */
  --line:     #e0e5ee;   /* card borders, table rules */
  --input-line: #c9d1de;
  --bg:       #f3f5f9;   /* page */
  --surface:  #ffffff;   /* cards */
  --nav-muted:#c9d3e6;  --nav-active-bg: #1c3460;
  /* status */
  --danger:   #b0343a;  --danger-bg: #fbeaea;  --danger-line: #f0c9cb;
  --success:  #276e44;  --success-bg: #eef7f1;
  --warn-ink: #5c3d00;  --warn-bg: #fbf1d6;
  --map-sea:  #dce8f2;
  /* shape */
  --radius-card: 14px; --radius-input: 10px; --radius-pill: 99px;
  --shadow-card: 0 1px 2px rgba(14,26,48,.05), 0 10px 30px rgba(14,26,48,.06);
}
```

Map colors come from the API's `desertLegend` and `densityLegend`. Don't duplicate them, except as a fallback.

**Typography** (Google Fonts):

| Role | Font | Use |
| --- | --- | --- |
| Display | **Bricolage Grotesque** 600/700/800 | H1 30 px, H2 19 px, KPI numbers 26–34 px, letter-spacing −0.015em |
| Body | **Figtree** 400/500/600/700 | 14.5 px / 1.5 |
| Mono | **JetBrains Mono** 400/500 | eyebrows, role badge, table headers: 10–11 px, uppercase, letter-spacing .06–.1em |

Numbers use `font-variant-numeric: tabular-nums`. Use the `en-PH` locale: `1,237,762`; percentages without decimals except flagged shares under 10% (one decimal).

**Components to build once**: GovStrip, AppHeader (role-aware), Tabs, FilterBar, KpiCard, MapCard (+ Legend), TopList, AreaTable (sortable), CenterHoverCard, SelectedCenterPanel, WhatIfPanel, FinderForm, FinderResult, Banner (danger/info/warn), Pill, Toast, EmptyState, Skeleton.

## 11. Non-functional requirements

- **Accessibility (WCAG 2.1 AA)**:
  - every input has a `<label>`; focus rings are visible
  - the map has a text alternative: the table *is* the accessible view, so link "View as table"
  - colors are never the only signal: always print the % next to the color
  - the planner is usable without a mouse: every recommended place has a **Place pin** button (see §7), so the pin can be placed by keyboard
  - minimum hit size 44 px on the Finder
- **Responsive**: Finder works from 360 px wide. Dashboard is desktop-first (≥ 1280) and usable at 768 (map stacks above the panels).
- **Performance**:
  - cache `dashboard/*` per `(level, code, limitMinutes)` for 5 min and `/geo/*` and `/public/qualifications` for a session
  - lazy-load MapLibre
  - national map GeoJSON is about 250 KB, so fetch it once per area
- **Privacy**: no analytics that capture location or search terms. Geolocation is used only for the request and never stored. Don't log tokens.
- **Locale and time**: Asia/Manila for all dates; English copy (Filipino later; keep strings in one `copy.ts` for i18n).
- **Errors**: one `apiFetch` wrapper that adds the token, parses `{ statusCode, message, error }` (`message` can be a string or a string array), handles 401 globally, and throws a typed `ApiError`.

## 12. Acceptance checklist

> The figures below were captured with `TRAVEL_MODEL=estimate`. Candidate counts and center counts never change, but flagged shares, desert counts, Top lists and what-if results shift when the backend runs `TRAVEL_MODEL=osrm` (real road + ferry times; e.g. national flagged 195,126, 15.8% instead of 215,442, 17.4%). Check the screen against the API response, not against these numbers.

1. **PO sign-in** (`po.negrosoccidental@…`):
   - lands on Negros Occidental with candidates 35,185 and flagged 5,675 (16.1%), 5 assessment deserts, 40 centers
   - Top 3 starts with Candoni, a Level 4 desert with "No center"
   - the map has 31 cities and municipalities
   - opening Region VI or another province by URL shows the 403 state
2. **RO sign-in** (`ro.region6@…`):
   - Region VI shows its flagged share and desert count, with a Top 3 of provinces
   - hovering the Talisay center shows the card with 4,540 predicted candidates
   - clicking a province drills down
3. **CO sign-in** (`co.planning@…`):
   - Philippines shows 1,237,762 candidates, 70,621 flagged (5.7%), 72 assessment deserts, 2,423 centers
   - Top 5 regions are CALABARZON, MIMAROPA, Central Visayas, Bicol, Caraga
   - there is no Insights tab, "Now" column or NEW tag
   - moving the travel limit slider to 30 minutes raises the desert count and flagged total, and "Reset" returns to the stored run
   - there is no Simulation runs page, nav item or re-run button
4. **What-if** (PO): a pin in Sipalay gives +4,540 newly served, flagged 16.1% → 3.2%, and 5 → 1 assessment deserts. A pin dropped in Cebu is rejected and snaps back.
5. **Finder**:
   - searching "Bantayan" with no qualification shows the desert banner and a 2 h 36 min first result
   - "City of Bago" + Cookery NC II shows the **No program data** card, not a desert
   - "Use my location" works and is denied gracefully
6. The Finder is usable with the keyboard alone and at 360 px wide.

## 13. Not in the backend yet

Build these with a clear placeholder and don't fake the data.

| Feature in design | Status | Frontend behavior |
| --- | --- | --- |
| TESDA SSO (T2MIS) | `501` | Button shows the "not connected yet" message |
| Send to Regional Office | no endpoint | Toast "coming soon" |
| Reports page | no endpoint | Placeholder page |
| Qualification filter on dashboards and what-if | no per-qualification candidate counts | Disabled select + hint |
| "#3 of 87 provinces" (PO) / "Highest region in the country" (RO) | national rank isn't exposed to RO/PO | Omit the sub-line until the backend adds `area.nationalRank` |
| Real road travel times / isochrone polygons | only when the backend runs `TRAVEL_MODEL=osrm` (isochrones return `503` otherwise) | Read `run.assumptions.travel`; show "Travel times are estimates" when it starts with `estimate` |

## 14. Suggested build order

1. Scaffold (Vite, router, Query, tokens, fonts) + `apiFetch` + generated types
2. Login + auth context + guards + AppHeader/GovStrip
3. Public Finder (no auth, exercises `/public` + `/geo`)
4. Dashboard Overview: KPIs, Top list, table
5. Map: choropleth (deserts and density views), legend, hover, drill-down
6. Centers layer + hover card + selected center reach
7. (removed: Insights tab)
8. What-if planner (and the travel limit slider)
9. (removed: Simulation runs page)
10. Empty, error and loading states, a11y pass, Playwright for §12

## 15. Added after the first version

Built on top of §1-§14 and covered by the browser tests. Expected values in the tests come from the API.

1. **Map views** (dashboard and planner): a switch above the map, in the URL as `?view=deserts|density` (deserts is the default; an old `?view=utilization` link opens deserts).
   - *Assessment deserts*: each area colored by `desertLevel` (0-4) using `desertLegend`. A desert is a city with candidates and no center within the travel range. Provinces and regions show the highest level inside. Legend text says so.
   - *Candidate density*: colored by `densityBand` using `densityLegend`; the top class is the hotspot. When 30% or more of the candidates shown are `estimatedCandidates` (an even share of a province total, not a count), the legend says so ("Read with care"), and such figures show `≈` in the table.
2. **Assessment deserts card** (under the Top list): `deserts.cities`, `deserts.candidates` and the four levels with their colors; "Show on the map" switches the view. A province or region with none says so.
3. **Top list**: ranks assessment deserts first (most candidates first), with a "level N" tag. Only areas with flagged candidates are listed, so there may be fewer than 5 or 3. The heading counts them: "Top 5 regions…" for the Philippines, "Top N provinces…" in a region, "Top N cities…" in a province, "The province that needs attention" when there is one. With none, the area shows a "None in <area>" card instead (the small label above it says "Worst first").
4. **Table**: a "Desert" column (level for a city, count for a province or region), sortable, with the desert-level and name filters from §6.1.
5. **What-if** (planner): the result also shows the region and province where the pin lands (`placeAreas`, within what the role may see: CO region and province, RO province, PO none) and the assessment deserts the center closes (`desertCitiesBefore/After`).
6. (removed: rolling history card and `GET /dashboard/trend`)
7. **Landing view** (home dashboard only, not drill-downs): who you are, what you see, when you signed in (`lastLoginAt`), when the results are from, flagged share and deserts, and role shortcuts. The map view and the centers toggle are remembered per user in this browser; the URL always wins.
8. **Selected center**: the 90-minute reach is drawn as true drive-time polygons (30, 60, 90 minutes) from `GET /centers/:id/isochrone`, with the 90-minute outline; the city shading is the fallback when that returns 503.
9. **Finder**: *Show route on map* draws the route (`GET /public/route`) with turn-by-turn steps, a ferry crossing marked, dashed lines from the real start and to the center, and a note when a center's position is approximate. A center within 500 m gets walking directions (a straight line or, with the foot server, along paths and roads) and is listed as "N min · walk". "Open in Google Maps" opens Google's directions.
10. **Basemap**: the dashboard, planner and finder maps sit on a full-colour OpenStreetMap basemap (OpenFreeMap "liberty": blue sea, green forest and grass, roads and place names), with the blue and green deepened a little in `baseStyle.ts`. The area colours are laid over the land, forest and parks but **under** the rivers, lakes, roads, buildings, boundaries and place names, so that detail stays visible on red. Areas in the "not a desert" class are left unpainted so the real map shows through; the density view paints every class. If the basemap can't load, a plain ocean-blue background is used. The map credit (OpenStreetMap, OpenFreeMap, OpenMapTiles) is required by their licences and must stay on every map; it starts collapsed behind the small "i" button (`collapseAttribution` in `map/setup.ts`) and opens on a click.
11. **No selected-area chip.** Picking an area highlights its row in the table and on the map; nothing extra is shown in the map header.
12. **Number formats** follow §12: flagged shares always have one decimal.
13. **Utilization removed; reach-based service rate added**: there is still no utilization rate, slot count, "centers full" or candidates-to-slots ratio. A reach-based `serviceRate` (served ÷ candidates; center: predicted candidates ÷ reach) is exposed instead. Don't treat it as capacity.

