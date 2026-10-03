# Changelog

## Unreleased

### Features

* **auth:** add OAuth2 sign-in — `authWithOAuth2` (popup flow), `authWithOAuth2Code` (direct code exchange), and typed `listAuthMethods`
* **queries:** accept arrays for `sort` and `expand` (`sort: ["-title", "published"]`) so editors suggest each field
* **queries:** add a typed filter builder — `svc.where("title").contains("x").and(svc.where("published").eq(true))`
  checks field names/operators (including relation dot-paths), escapes values, and works anywhere a
  `filter` string is accepted; `svc.where("id").in([...])` / `.notIn([...])` cover list membership
  without hand-written OR chains

### Bug Fixes

* **expand:** keep expanded records when a `fields` projection is active (schema
  default, `select(...)`, or explicit `fields`) — the strict `fields` param no
  longer silently drops `expand`
* **expand:** support field selection via dotted tokens
  (`expand: "owner.name,owner.email"`) — the relation is expanded and only the
  requested fields are kept. Applied client-side so it works on the LazyPock
  server (which always returns the full related record) as well as PocketBase;
  dotted paths that are all relations keep their nested-expand meaning
* **expand:** never emit `fields=*` plus other tokens — the LazyPock server
  treats that as a strict projection and returned empty records; the relation
  field and `expand.<key>` entries are merged into an explicit projection instead

## [0.17.0](https://github.com/gnuzd/lazypock-ts/compare/v0.16.1...v0.17.0) (2026-10-03)


### Features

* **files:** preset variant URLs, upload origin/variants and direct upload ([2a26579](https://github.com/gnuzd/lazypock-ts/commit/2a2657961e53001e976b26eaa61b379d7cf90179))
* **files:** preset variant URLs, upload origin/variants, direct upload ([2b08028](https://github.com/gnuzd/lazypock-ts/commit/2b0802820f12a816024fc818977dacc6bc6e052c))

## [0.16.1](https://github.com/gnuzd/lazypock-ts/compare/v0.16.0...v0.16.1) (2026-10-02)


### Bug Fixes

* **oauth2:** relay the authorization code and forward createData ([1ed93e5](https://github.com/gnuzd/lazypock-ts/commit/1ed93e536b076104287f2a8f41e56af9184f4ec6))
* **oauth2:** relay the authorization code and forward createData ([bf5e922](https://github.com/gnuzd/lazypock-ts/commit/bf5e9222e0385fdcdc2cfb8e98e5a6662a43ad76))

## [0.16.0](https://github.com/gnuzd/lazypock-ts/compare/v0.15.0...v0.16.0) (2026-09-29)


### Features

* **auth:** add email verification, password reset, and email change methods ([6d84b10](https://github.com/gnuzd/lazypock-ts/commit/6d84b107128d29eb39bd480d3bb4c74317750b59))
* **auth:** add email verification, password reset, and email change methods ([d93ff82](https://github.com/gnuzd/lazypock-ts/commit/d93ff82e75504e390831b0aeb4d3118a22dad712))


### Bug Fixes

* **cli:** warn when using deprecated lazypock-gen bin or flags ([16f9ffc](https://github.com/gnuzd/lazypock-ts/commit/16f9ffcb410ebabba85a7acaa53c30ab385f1e85))

## [0.15.0](https://github.com/gnuzd/lazypock-ts/compare/v0.14.0...v0.15.0) (2026-09-28)


### Features

* **filter:** accept a typed where-callback in the filter option ([41b34f6](https://github.com/gnuzd/lazypock-ts/commit/41b34f63aab9cbbdb852c8995446c99258d971ea))
* **filter:** typed where-callback in the filter option ([c42431f](https://github.com/gnuzd/lazypock-ts/commit/c42431fca29672055133bfaf3a758194124443da))

## [0.14.0](https://github.com/gnuzd/lazypock-ts/compare/v0.13.0...v0.14.0) (2026-09-27)


### Features

* **filter:** accept relation dot-paths in where() ([276b9b9](https://github.com/gnuzd/lazypock-ts/commit/276b9b902d260d6307568f0185be85a30de80d8e))
* **filter:** add in() / notIn() list membership to the builder ([d2310f2](https://github.com/gnuzd/lazypock-ts/commit/d2310f2a4b1b18177dc79aeb4add080c947d9ce3))
* **filter:** re-enable relation dot-paths in where() ([2414343](https://github.com/gnuzd/lazypock-ts/commit/2414343a94bd680725119b72018be8df1220c691))
* **queries:** array sort/expand + typed filter builder ([b284a6b](https://github.com/gnuzd/lazypock-ts/commit/b284a6b2ab75d76ac88fb4335d76267dd3c5e2c8))
* **queries:** expand field selection + editor autocomplete (array sort/expand, typed filter builder) ([0616a2e](https://github.com/gnuzd/lazypock-ts/commit/0616a2ecbc1f32ec22e32cbb6981e763c80360ce))


### Bug Fixes

* **expand:** keep expansions under field projections + field selection ([36d9801](https://github.com/gnuzd/lazypock-ts/commit/36d9801968ac4dc3f64efc5612b2d97db90125f9))
* **queries:** make expand/filter features work against the LazyPock server ([df5238e](https://github.com/gnuzd/lazypock-ts/commit/df5238e1ce4350ba1fec77c24419ad699fd22510))

## [0.13.0](https://github.com/gnuzd/lazypock-ts/compare/v0.12.0...v0.13.0) (2026-09-23)


### Features

* **auth:** add OAuth2 sign-in (authWithOAuth2 + authWithOAuth2Code) ([2ce103d](https://github.com/gnuzd/lazypock-ts/commit/2ce103d90e0cbc3130f6081e4cdac63824738952))
* **auth:** add OAuth2 sign-in (authWithOAuth2 + authWithOAuth2Code) ([ca59665](https://github.com/gnuzd/lazypock-ts/commit/ca5966533ca356654a90ab9dca6af1c350fefccd))

## [0.12.0](https://github.com/gnuzd/lazypock-ts/compare/v0.11.0...v0.12.0) (2026-09-22)


### Features

* **types:** accept PocketBase ? filter operators ([74dc397](https://github.com/gnuzd/lazypock-ts/commit/74dc397e50f99e66b7d22ce68ca24fd6111feb6f))
* **types:** accept PocketBase ? filter operators (any/at-least-one-of) ([6f5b79c](https://github.com/gnuzd/lazypock-ts/commit/6f5b79c1aa8d673cecd5284894e45e34b0eb38bb))


### Bug Fixes

* **codegen:** don't redeclare BaseRecord keys; type autodate as string ([e5e7f27](https://github.com/gnuzd/lazypock-ts/commit/e5e7f27f9c0302ec4710894c8d99d5ec0f6f673c))
* **codegen:** don't redeclare BaseRecord keys; type autodate as string ([0fae010](https://github.com/gnuzd/lazypock-ts/commit/0fae010a332ab40f3761b684aa57fa478a0b726e))

## [0.11.0](https://github.com/gnuzd/lazypock-ts/compare/v0.10.2...v0.11.0) (2026-08-28)


### Features

* **types:** typed expanded records via per-collection expand maps ([1f523d3](https://github.com/gnuzd/lazypock-ts/commit/1f523d3f71705ec19519a192be82d505fd838115))
* **types:** typed expanded records via per-collection expand maps ([9c110b6](https://github.com/gnuzd/lazypock-ts/commit/9c110b6d3837aae0d368fadfc89f27e31e8fab9c))

## [0.10.2](https://github.com/gnuzd/lazypock-ts/compare/v0.10.1...v0.10.2) (2026-08-27)


### Bug Fixes

* **types:** validate every expand/sort/filter token + type expanded records ([bc25cab](https://github.com/gnuzd/lazypock-ts/commit/bc25cab7818bdeca958f39e6715ec1017cc7b33e))

## [0.10.1](https://github.com/gnuzd/lazypock-ts/compare/v0.10.0...v0.10.1) (2026-08-26)


### Bug Fixes

* **types:** hidden relation fields are expandable/filterable/selectable ([658873e](https://github.com/gnuzd/lazypock-ts/commit/658873e947be5dd1a61de9678fceda5c1988cd77))
* **types:** hidden relation fields are expandable/filterable/selectable ([7d466d4](https://github.com/gnuzd/lazypock-ts/commit/7d466d47ab3c688b540c425dec79948182ea9077))

## [0.10.0](https://github.com/gnuzd/lazypock-ts/compare/v0.9.0...v0.10.0) (2026-08-26)


### Features

* **realtime:** auto connection id for origin-exclusion ([b705b4a](https://github.com/gnuzd/lazypock-ts/commit/b705b4a2192d43060073218a35c71a0e85a6c1c3))
* **realtime:** auto connection id for origin-exclusion ([ade8c47](https://github.com/gnuzd/lazypock-ts/commit/ade8c47a68246ffeac26dfdd9ab941e45cfd4ebc))


### Bug Fixes

* **types:** suggest collection names + accept real-world filter/expand strings ([1ad62c3](https://github.com/gnuzd/lazypock-ts/commit/1ad62c32a31b4abf3c0884a3412587eb57b53fce))
* **types:** suggest collection names and accept real-world filter/expand strings ([dbb27aa](https://github.com/gnuzd/lazypock-ts/commit/dbb27aabc4bdad4e362c0d6fc9740c7a59cead50))

## [0.9.0](https://github.com/gnuzd/lazypock-ts/compare/v0.8.4...v0.9.0) (2026-08-23)


### Features

* **realtime:** pocketbase-style subscribe, auto-auth socket, custom channels ([34998d0](https://github.com/gnuzd/lazypock-ts/commit/34998d0aa6ceaee1f1c2331fbdee0153e97cf183))
* **realtime:** PocketBase-style subscribe, auto-auth socket, custom channels ([9281442](https://github.com/gnuzd/lazypock-ts/commit/92814425443e5ab8448112e94a9048d7133961ab))

## [0.8.4](https://github.com/gnuzd/lazypock-ts/compare/v0.8.3...v0.8.4) (2026-08-22)


### Bug Fixes

* **codegen:** expose write-only `password` in auth collection create data ([c9a10c0](https://github.com/gnuzd/lazypock-ts/commit/c9a10c038bc67e8124eed20e8befdaaa650752d5))
* **codegen:** expose write-only `password` in auth collection create data ([904f204](https://github.com/gnuzd/lazypock-ts/commit/904f20458c397fe1f0650b4648ae47c2397987fa))

## [0.8.3](https://github.com/gnuzd/lazypock-ts/compare/v0.8.2...v0.8.3) (2026-08-22)


### Bug Fixes

* **sdk:** clarify public API surface contract in barrel doc comment ([45532eb](https://github.com/gnuzd/lazypock-ts/commit/45532ebeebfadbbc14b90dbebde23ac6b9f03e99))
* **sdk:** clarify public API surface contract in barrel doc comment ([63cb7d1](https://github.com/gnuzd/lazypock-ts/commit/63cb7d1dd1dbfcdf678e4c1a2501a4c1b0be5e59))

## [0.8.2](https://github.com/gnuzd/lazypock-ts/compare/v0.8.1...v0.8.2) (2026-08-21)


### Bug Fixes

* **sdk:** throw on abort during body read + relax create-data requiredness ([9f87128](https://github.com/gnuzd/lazypock-ts/commit/9f8712867acbfdbf4cd80c5a9f9ddaabae660982))
