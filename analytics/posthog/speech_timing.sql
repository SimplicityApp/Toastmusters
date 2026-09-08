-- speech_timing — one row per completed speech, classified against Toastmasters
-- timing rules, with bots, developer devices, and non-production hosts removed.
-- Save this in PostHog as a view named `speech_timing`.
--
-- Thresholds mirror DEFAULT_ROLE_RULES in packages/shared/timingRules.js.
-- Keep the two in sync: if a default changes there, change it here.
--
-- Buckets:
--   under_minimum  never reached the green minimum (aborted, or a test tap)
--   within_limits  finished on green or yellow — inside the qualifying window
--   in_grace       past red, but inside graceAfterRed (would NOT be disqualified)
--   over_time      past red + grace (would be disqualified in a contest)
--   runaway        over 3x the maximum — timer left running, exclude from analysis
--   unknown_role   a custom role name with no default rule; filtered out downstream
--
-- Exclusions (see README for why each one):
--   1. $virt_is_bot — crawlers and automation
--   2. non-production hosts — localhost, *-dev.*, vercel.app, workers.dev
--   3. any person who has EVER hit a non-production host — catches developer
--      devices by behaviour rather than by geography, so real District 61
--      (Montreal / Brossard / Saint-Hubert) users are not wrongly dropped
SELECT
  timestamp,
  person_id,
  country,
  role,
  d     AS duration_sec,
  red   AS red_sec,
  grace AS grace_sec,
  st    AS final_status,
  multiIf(
    red < 0,            'unknown_role',
    st = 'blue',        'under_minimum',
    d <= red,           'within_limits',
    d <= red + grace,   'in_grace',
    d <= red * 3,       'over_time',
                        'runaway'
  ) AS bucket
FROM (
  SELECT
    timestamp,
    person_id,
    properties.role                 AS role,
    properties.$geoip_country_name  AS country,
    toFloat(properties.duration)    AS d,
    properties.final_status         AS st,
    multiIf(
      properties.role = 'Short Roles',             60.0,
      properties.role = 'Table Topics Speech',    120.0,
      properties.role = 'Table Topics Evaluation', 60.0,
      properties.role = 'Standard Speech',        420.0,
      properties.role = 'Ice Breaker',            360.0,
      properties.role = 'Speech Evaluation',      180.0,
      properties.role = 'General Evaluation',     300.0,
      properties.role = 'Custom',                  60.0,
      -1.0
    ) AS red,
    multiIf(
      properties.role IN ('Short Roles', 'Table Topics Evaluation', 'Custom'), 15.0,
      30.0
    ) AS grace
  FROM events
  WHERE event = 'speech_finished'
    AND properties.$virt_is_bot != true
    AND properties.$host IN (
      'zoom.timer.simple-tech.app', 'www.timer.simple-tech.app', 'timer.simple-tech.app',
      'zoom.timer.toastmusters.com', 'www.timer.toastmusters.com', 'timer.toastmusters.com'
    )
    AND person_id NOT IN (
      SELECT DISTINCT person_id
      FROM events
      WHERE properties.$host IS NOT NULL
        AND properties.$host NOT IN (
          'zoom.timer.simple-tech.app', 'www.timer.simple-tech.app', 'timer.simple-tech.app',
          'zoom.timer.toastmusters.com', 'www.timer.toastmusters.com', 'timer.toastmusters.com'
        )
    )
)
