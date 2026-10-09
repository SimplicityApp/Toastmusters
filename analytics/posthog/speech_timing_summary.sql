-- Per-role timing rollup. Requires the `speech_timing` view (speech_timing.sql).
--
-- `real_speeches` is the honest denominator: it excludes aborted timers and
-- runaway sessions, so percentages describe speeches that actually happened.
SELECT
  role,
  countIf(bucket IN ('within_limits', 'in_grace', 'over_time'))            AS real_speeches,
  countIf(bucket IN ('in_grace', 'over_time'))                             AS past_red,
  countIf(bucket = 'in_grace')                                             AS recovered_in_grace,
  countIf(bucket = 'over_time')                                            AS disqualifiable,
  round(100.0 * countIf(bucket IN ('in_grace','over_time'))
        / nullIf(countIf(bucket IN ('within_limits','in_grace','over_time')), 0), 1) AS pct_past_red,
  round(100.0 * countIf(bucket = 'over_time')
        / nullIf(countIf(bucket IN ('within_limits','in_grace','over_time')), 0), 1) AS pct_disqualifiable,
  countIf(bucket = 'under_minimum')                                        AS aborted,
  countIf(bucket = 'runaway')                                              AS runaway_excluded
FROM speech_timing
WHERE bucket != 'unknown_role'
GROUP BY role
ORDER BY real_speeches DESC
