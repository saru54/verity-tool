// Spotify SheerID student verification (US students).
// URL: /verify/{programId}/?country=US&locale=en&verificationId={vid}
// Form fields in order: country → school → firstName → lastName → email → consent.
// No birth date. Consent is mandatory to enable the submit button.
import { countryChoice } from '../labels.js';
import { organizationIsSelected } from '../organization.js';

export default {
  key: 'spotify',
  label: 'Spotify 学生验证',
  // Initial fields visible when the form loads.
  readyFields: ['country', 'firstName', 'lastName', 'email'],
  // Consent: always check, not optional.
  consent: { required: true, autoCheck: true },
  defaultCountry: 'US',
  defaultLocale: 'en',
  // Spotify: once documents are submitted and SheerID enters pending review,
  // the task is complete. No need to keep polling for the final verdict.
  pendingIsFinal: true,

  async fill({ page, data, selectors, field, set, choose, locales, log, interaction }) {
    // 1. Country — appears first, selecting it unlocks organization.
    await choose('country', countryChoice(data.country, locales));
    // 2. Organization (school) — appears after country is selected.
    await choose('organization', {
      label: data.organization.optionText,
      searchText: data.organization.name,
      retrySearch: true,
      normalizeLabelSeparators: true,
      isSelectionCommitted: options => organizationIsSelected(page, options),
      allowLocationSuffix: data.organization.optionText.trim() === data.organization.name.trim(),
    });
    // 3. First / last name.
    await set('firstName', data.firstName);
    await set('lastName', data.lastName);
    // 4. Email.
    await set('email', data.email);
    // 5. Consent — required on Spotify, must be checked to enable submit.
    const box = await field('consent');
    if (!(await box.isChecked())) {
      if (interaction?.click) await interaction.click(box);
      else await box.check();
      log('field_filled', { stage: 'fill', field: 'consent', note: 'auto-checked' });
    } else {
      log('field_filled', { stage: 'fill', field: 'consent', note: 'already-checked' });
    }
  },
};
