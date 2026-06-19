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

/* Placeholder calendar dates per round key. The live feed overrides
   these per match once real bracket dates exist. */
var KNOCKOUT_DATES = {
  R32:   "2026-06-28",
  R16:   "2026-07-04",
  QF:    "2026-07-09",
  SF:    "2026-07-14",
  Final: "2026-07-19"
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
    var dateISO = KNOCKOUT_DATES[round.name] || null;
    round.matches.forEach(function (mt, i) {
      fixtures.push({
        id: mt.id,
        round: round.name,
        roundLabel: round.label,
        matchNumber: i + 1,
        home: fixtureSide(mt.home, byId),
        away: fixtureSide(mt.away, byId),
        dateISO: dateISO,
        utcDate: null,
        status: mt.status || "SCHEDULED",
        homeGoals: typeof mt.homeGoals === "number" ? mt.homeGoals : null,
        awayGoals: typeof mt.awayGoals === "number" ? mt.awayGoals : null,
        winner: mt.winner || null,
        venue: null,
        minute: null,
        cards: null,
        matchId: null
      });
    });
  });

  return fixtures;
}
