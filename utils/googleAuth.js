import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { Auth } from '../models/auth.model.js';

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.GOOGLE_CALLBACK_URL,
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const email = profile.emails[0].value;
        let user = await Auth.findOne({ email });

        if (!user) {
          user = await Auth.create({
            name: profile.displayName,
            email,
            password: Math.random().toString(36).slice(-8),
          });
        }

        return done(null, user);
      } catch (err) {
        return done(err, null);
      }
    }
  )
);

passport.serializeUser((user, done) => done(null, user._id));
passport.deserializeUser(async (id, done) => {
  const user = await Auth.findById(id);
  done(null, user);
});
