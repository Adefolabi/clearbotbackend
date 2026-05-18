'use strict';

const VALID_CAMPUSES = ['Iwo Campus', 'Ogbomosho Campus', 'Abuja Campus'];
const MATRIC_PATTERN = /^[A-Za-z]{2}\d{2}[A-Za-z]{3}\d{4}$/;

/**
 * Validates the body of POST /api/assessment/start.
 * Returns { valid: true } or { valid: false, errors: string[] }.
 */
function validateStartRequest(body) {
  const errors = [];
  const { matricNumber, password, campus, defaultRating, perCourseRatings } = body;

  if (!matricNumber || typeof matricNumber !== 'string') {
    errors.push('matricNumber is required and must be a string');
  } else if (!MATRIC_PATTERN.test(matricNumber)) {
    errors.push('matricNumber must match the pattern: 2 letters, 2 digits, 3 letters, 4 digits (e.g. BU22CSC1081)');
  }

  if (!password || typeof password !== 'string') {
    errors.push('password is required and must be a string');
  } else if (password.length < 4) {
    errors.push('password must be at least 4 characters');
  }

  if (!campus || typeof campus !== 'string') {
    errors.push('campus is required');
  } else if (!VALID_CAMPUSES.includes(campus)) {
    errors.push(`campus must be one of: ${VALID_CAMPUSES.join(', ')}`);
  }

  if (defaultRating === undefined || defaultRating === null) {
    errors.push('defaultRating is required');
  } else if (!Number.isInteger(defaultRating) || defaultRating < 0 || defaultRating > 4) {
    errors.push('defaultRating must be an integer between 0 and 4 inclusive');
  }

  if (perCourseRatings !== undefined) {
    if (typeof perCourseRatings !== 'object' || Array.isArray(perCourseRatings)) {
      errors.push('perCourseRatings must be an object');
    } else {
      for (const [course, rating] of Object.entries(perCourseRatings)) {
        if (!Number.isInteger(rating) || rating < 0 || rating > 4) {
          errors.push(`perCourseRatings["${course}"] must be an integer between 0 and 4`);
        }
      }
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

module.exports = { validateStartRequest };
