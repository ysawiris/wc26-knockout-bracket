/* ============================================================
   Knockout fixtures — flat projection of the bracket.

   buildKnockoutFixtures(bracketRounds, field) flat-maps every
   bracket match into the legacy "Fixture" shape so that flat
   readers (renderSchedule, race, stats, matchcenter, recaps,
   share-card) keep working — they read fx.round instead of the
   old fx.group, and fx.matchNumber instead of fx.matchday.

   Names/flags are resolved from the bracket match's home/away
   slots (already filled from COUNTRY_BY_ID by store.buildBracket),
   with `field` as a fallback lookup by countryId. TBD slots carry
   null name/flag/countryId.

   Placeholder dates per round (one date stamped on every match in
   that round); exact kickoff times/venues are layered on later by
   the live feed via Live.attachToFixtures (matching on fx.round).
   ============================================================ */

/* Representative calendar date per round key — a fallback for rounds whose
   per-match schedule isn't pinned yet (R16→Final, whose teams stay TBD until
   the bracket fills). The real Round of 32 is fully dated per match in
   KNOCKOUT_SCHEDULE below. A live feed still overrides any of these per match. */
var KNOCKOUT_DATES = {
  R32:   "2026-06-28", // earliest R32 day; real per-match dates live in KNOCKOUT_SCHEDULE
  R16:   "2026-07-04",
  QF:    "2026-07-09",
  SF:    "2026-07-14",
  Final: "2026-07-19"
};

/* REAL Round-of-32 schedule — 2026 FIFA World Cup official fixtures, matches
   M73–M88, played 28 Jun – 3 Jul 2026. Keyed by the bracket match id
   (r32-1 … r32-16, which follow R32_PAIRINGS and the FIFA match-number
   annotations in data.js). `dateISO` is the venue-local match date; `utc` is
   the exact kickoff instant, so kickoff times, the countdown and calendar links
   all render in each viewer's own timezone; `venue` is "Stadium · City".
   Cross-checked across Wikipedia + SI/Yahoo with per-venue DST handled (US
   Eastern UTC-4, Central UTC-5, Pacific UTC-7; Mexico no-DST UTC-6). To re-pin
   after a real-world schedule change, edit only this map. */
var KNOCKOUT_SCHEDULE = {
  //  id     :  FIFA #  matchup (from R32_PAIRINGS)
  "r32-1":  { dateISO: "2026-06-29", utc: "2026-06-29T20:30:00Z", venue: "Gillette Stadium · Boston" },       // M74  GER v PAR
  "r32-2":  { dateISO: "2026-06-30", utc: "2026-06-30T21:00:00Z", venue: "MetLife Stadium · New York" },      // M77  FRA v SWE
  "r32-3":  { dateISO: "2026-06-28", utc: "2026-06-28T19:00:00Z", venue: "SoFi Stadium · Los Angeles" },      // M73  RSA v CAN
  "r32-4":  { dateISO: "2026-06-29", utc: "2026-06-30T01:00:00Z", venue: "Estadio BBVA · Monterrey" },        // M75  NED v MAR
  "r32-5":  { dateISO: "2026-07-02", utc: "2026-07-02T23:00:00Z", venue: "BMO Field · Toronto" },             // M83  POR v CRO
  "r32-6":  { dateISO: "2026-07-02", utc: "2026-07-02T19:00:00Z", venue: "SoFi Stadium · Los Angeles" },      // M84  ESP v AUT
  "r32-7":  { dateISO: "2026-07-01", utc: "2026-07-02T00:00:00Z", venue: "Levi's Stadium · San Francisco" },  // M81  USA v BIH
  "r32-8":  { dateISO: "2026-07-01", utc: "2026-07-01T20:00:00Z", venue: "Lumen Field · Seattle" },           // M82  BEL v SEN
  "r32-9":  { dateISO: "2026-06-29", utc: "2026-06-29T17:00:00Z", venue: "NRG Stadium · Houston" },           // M76  BRA v JPN
  "r32-10": { dateISO: "2026-06-30", utc: "2026-06-30T17:00:00Z", venue: "AT&T Stadium · Dallas" },           // M78  CIV v NOR
  "r32-11": { dateISO: "2026-06-30", utc: "2026-07-01T01:00:00Z", venue: "Estadio Azteca · Mexico City" },    // M79  MEX v ECU
  "r32-12": { dateISO: "2026-07-01", utc: "2026-07-01T16:00:00Z", venue: "Mercedes-Benz Stadium · Atlanta" }, // M80  ENG v COD
  "r32-13": { dateISO: "2026-07-03", utc: "2026-07-03T22:00:00Z", venue: "Hard Rock Stadium · Miami" },       // M86  ARG v CPV
  "r32-14": { dateISO: "2026-07-03", utc: "2026-07-03T18:00:00Z", venue: "AT&T Stadium · Dallas" },           // M88  AUS v EGY
  "r32-15": { dateISO: "2026-07-02", utc: "2026-07-03T03:00:00Z", venue: "BC Place · Vancouver" },            // M85  SUI v ALG
  "r32-16": { dateISO: "2026-07-03", utc: "2026-07-04T01:30:00Z", venue: "Arrowhead Stadium · Kansas City" }  // M87  COL v GHA
};

/* Build a field-by-id lookup, tolerating either a {byId} wrapper or a
   raw array, or falling back to the global COUNTRY_BY_ID. */
function fieldById(field) {
  if (field && field.byId) return field.byId;
  if (Array.isArray(field)) {
    var map = {};
    field.forEach(function (c) { map[c.id] = c; });
    return map;
  }
  return (typeof COUNTRY_BY_ID !== "undefined") ? COUNTRY_BY_ID : {};
}

/* Resolve a bracket slot ({countryId,name,flag,...}) into the fixture
   home/away shape { name, flag, countryId }, using `byId` as fallback. */
function fixtureSide(slot, byId) {
  if (!slot) return { name: null, flag: null, countryId: null };
  var cid = slot.countryId || null;
  var name = slot.name || null;
  var flag = slot.flag || null;
  if ((!name || !flag) && cid && byId[cid]) {
    name = name || byId[cid].name;
    flag = flag || byId[cid].flag;
  }
  return { name: name, flag: flag, countryId: cid };
}

/* Flat-map bracket rounds into Fixture objects.

   Fixture = {
     id, round, roundLabel, matchNumber,
     home: { name, flag, countryId },
     away: { name, flag, countryId },
     dateISO, utcDate, status, homeGoals, awayGoals, winner,
     venue, minute, cards, matchId
   }
   where `winner` mirrors the match's "home"|"away"|null. */
function buildKnockoutFixtures(bracketRounds, field) {
  var fixtures = [];
  if (!bracketRounds || !bracketRounds.length) return fixtures;
  var byId = fieldById(field);

  bracketRounds.forEach(function (round) {
    var roundDate = KNOCKOUT_DATES[round.name] || null;
    round.matches.forEach(function (mt, i) {
      // Real per-match schedule (R32) takes precedence; later rounds fall back to
      // the round's representative date with no fixed kickoff/venue yet.
      var sch = KNOCKOUT_SCHEDULE[mt.id] || null;
      fixtures.push({
        id: mt.id,
        round: round.name,
        roundLabel: round.label,
        matchNumber: i + 1,
        home: fixtureSide(mt.home, byId),
        away: fixtureSide(mt.away, byId),
        dateISO: sch ? sch.dateISO : roundDate,
        utcDate: sch ? sch.utc : null,
        status: mt.status || "SCHEDULED",
        homeGoals: typeof mt.homeGoals === "number" ? mt.homeGoals : null,
        awayGoals: typeof mt.awayGoals === "number" ? mt.awayGoals : null,
        winner: mt.winner || null,
        venue: sch ? sch.venue : null,
        minute: null,
        cards: null,
        matchId: null
      });
    });
  });

  return fixtures;
}
