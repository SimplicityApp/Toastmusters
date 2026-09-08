import posthog from 'posthog-js';

/**
 * Initialize PostHog analytics
 * Gracefully handles failures - app will work without PostHog
 */
export function initPostHog() {
  const posthogKey = import.meta.env.VITE_PUBLIC_POSTHOG_KEY;
  const posthogHost = import.meta.env.VITE_PUBLIC_POSTHOG_HOST;

  // Only initialize if both key and host are provided
  if (!posthogKey || !posthogHost) {
    return null;
  }

  try {
    posthog.init(posthogKey, {
      api_host: posthogHost,
      // posthogHost is our managed reverse proxy (e.simple-tech.app), so links
      // back to PostHog (toolbar, survey editor) need the real app host.
      ui_host: 'https://us.posthog.com',
      person_profiles: 'always',
      // Enable autocapture for pageviews and clicks
      autocapture: true,
      // Capture pageviews automatically
      capture_pageview: true,
      // Capture pageleaves automatically
      capture_pageleave: true,
      // Disable session recording by default (can be enabled later if needed)
      disable_session_recording: true,
      // Keep surveys enabled but we'll control display manually
      // Automatic display is prevented by survey configuration (Feedback Button mode)
      disable_surveys: false,
      // IMPORTANT: Do not disable feature flags - surveys use them internally
      // advanced_disable_feature_flags: false, // Don't set this to true!
      // Load surveys
      loaded: (posthog) => {
        // Prevent automatic survey display by intercepting it
        // Store original displaySurvey method
        const originalDisplaySurvey = posthog.displaySurvey;
        let isManualDisplay = false;
        
        // Override displaySurvey to track manual calls
        posthog.displaySurvey = function(surveyId) {
          // Only allow display if it's a manual call (marked by our code)
          if (isManualDisplay) {
            isManualDisplay = false; // Reset flag
            return originalDisplaySurvey.call(this, surveyId);
          }
          // Block automatic display
          return false;
        };
        
        // Expose method to mark manual display
        posthog._allowManualSurveyDisplay = function() {
          isManualDisplay = true;
        };
      }
    });

    return posthog;
  } catch (error) {
    console.error('Failed to initialize PostHog:', error);
    return null;
  }
}

/**
 * Track a custom event with PostHog
 * Safely handles cases where PostHog is not initialized
 * 
 * @param {string} eventName - Event name in snake_case (e.g., 'timer_started')
 * @param {Object} properties - Event properties
 */
export function trackEvent(eventName, properties = {}) {
  try {
    if (posthog && posthog.__loaded) {
      posthog.capture(eventName, properties);
    }
  } catch (error) {
    // Silently fail - don't break the app if tracking fails
    if (import.meta.env.DEV) {
      console.warn('PostHog tracking failed:', error);
    }
  }
}

/**
 * Identify a user (if user accounts are added in the future)
 * 
 * @param {string} userId - Unique user identifier
 * @param {Object} userProperties - User properties
 */
export function identifyUser(userId, userProperties = {}) {
  try {
    if (posthog && posthog.__loaded) {
      posthog.identify(userId, userProperties);
    }
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn('PostHog identify failed:', error);
    }
  }
}

/**
 * Attach properties to the current person, so every other event can be
 * segmented by them (e.g. which Toastmasters club the user belongs to).
 *
 * @param {Object} properties - Person properties
 */
export function setUserProperties(properties = {}) {
  try {
    if (posthog && posthog.__loaded) {
      posthog.setPersonProperties(properties);
    }
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn('PostHog setPersonProperties failed:', error);
    }
  }
}

/**
 * Attach properties to every event captured from now on (PostHog "super
 * properties"), for facts about this session rather than about the person —
 * which meeting this is, where the app was opened. Not persisted: the next
 * meeting must not inherit this one's id.
 *
 * @param {Object} properties
 */
export function registerSessionProperties(properties = {}) {
  try {
    if (posthog && posthog.__loaded) {
      posthog.register(properties, { persistent: false });
    }
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn('PostHog register failed:', error);
    }
  }
}

/**
 * Reset user identification (for logout)
 */
export function resetUser() {
  try {
    if (posthog && posthog.__loaded) {
      posthog.reset();
    }
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn('PostHog reset failed:', error);
    }
  }
}

/**
 * Get active surveys available for the current user
 * @returns {Promise<Array>} Array of survey objects
 */
export async function getActiveSurveys() {
  try {
    if (posthog && posthog.__loaded) {
      // Wait for surveys to be loaded
      await new Promise((resolve) => {
        if (posthog.__surveysLoaded) {
          resolve();
        } else {
          posthog.onSurveysLoaded(() => resolve());
        }
      });

      // Get surveys - PostHog web SDK uses getActiveMatchingSurveys() (synchronous)
      if (typeof posthog.getActiveMatchingSurveys === 'function') {
        const surveys = posthog.getActiveMatchingSurveys();
        return Array.isArray(surveys) ? surveys : [];
      }
      
      // Fallback: try getSurveys if available (may be async in some versions)
      if (typeof posthog.getSurveys === 'function') {
        const surveys = typeof posthog.getSurveys.then === 'function' 
          ? await posthog.getSurveys() 
          : posthog.getSurveys();
        return Array.isArray(surveys) ? surveys : [];
      }
    }
    return [];
  } catch (error) {
    if (import.meta.env.DEV) {
      console.error('Error getting active surveys:', error);
    }
    return [];
  }
}

/**
 * Get a specific survey by ID
 * @param {string} surveyId - The ID of the survey to retrieve
 * @returns {Promise<Object|null>} Survey object or null if not found
 */
export async function getSurveyById(surveyId) {
  try {
    const surveys = await getActiveSurveys();
    const survey = surveys.find((s) => (s.id || s.surveyId) === surveyId);
    return survey || null;
  } catch (error) {
    if (import.meta.env.DEV) {
      console.error('Error getting survey by ID:', error);
    }
    return null;
  }
}

/**
 * Display a survey by ID manually
 * @param {string} surveyId - Optional survey ID. If not provided, displays first available survey
 * @returns {Promise<boolean>} True if survey was displayed, false otherwise
 */
export async function displaySurveyById(surveyId = null) {
  try {
    if (!posthog || !posthog.__loaded) {
      return false;
    }

    // Wait for surveys to be loaded
    await new Promise((resolve) => {
      if (posthog.__surveysLoaded) {
        resolve();
      } else {
        posthog.onSurveysLoaded(() => resolve());
      }
    });

    if (surveyId) {
      // Display specific survey by ID
      posthog.displaySurvey(surveyId);
      return true;
    } else {
      // Get first available survey
      const surveys = await getActiveSurveys();
      if (surveys.length > 0) {
        const firstSurvey = surveys[0];
        const id = firstSurvey.id || firstSurvey.surveyId;
        if (id) {
          posthog.displaySurvey(id);
          return true;
        }
      }
    }
    return false;
  } catch (error) {
    if (import.meta.env.DEV) {
      console.error('Error displaying survey:', error);
    }
    return false;
  }
}
