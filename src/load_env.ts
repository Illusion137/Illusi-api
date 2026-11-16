import dotenv from 'dotenv';

// The developer's .env can be the production one (Resend, Sentry, buckets): tests never read it.
if (process.env.NODE_ENV !== 'test') dotenv.config({ quiet: true });
