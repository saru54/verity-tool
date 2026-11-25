// Google One SheerID student verification (US universities).
// URL: https://services.sheerid.com/verify/5f19.../?country=US&locale=en
// Form fields in order: country → school → firstName → lastName → birthDate
//   (month/day/year) → email → studentStatus (optional) → consent (optional).
import { countryChoice, monthChoice, studentStatusChoice } from '../labels.js';
import { visibleField } from '../../../browser/form.js';
import { organizationIsSelected } from '../organization.js';

export default {
  key: 'google-one',
  label: 'Google One 学生验证',
  // Initial fields visible when the form loads (progressive form shows more later).
  readyFields: ['country', 'firstName', 'lastName', 'email'],
  consent: { required: false, autoCheck: true },
  defaultCountry: 'US',
  defaultLocale: 'en',

  async fill({ page, data, selectors, field, set, choose, locales, log, config, interaction }) {
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
    // 4. Birth date — appears after organization is selected.
    const [year, month, day] = data.birthDate.split('-');
    await choose('birthMonth', monthChoice(month, locales));
    await set('birthDay', day);
    await set('birthYear', year);
    // 5. Email.
    await set('email', data.email);
    // 6. Student status — only if the program exposes multiple statuses.
    const statuses = config.program?.availableStatuses ?? [];
    if (statuses.length > 1) await choose('studentStatus', studentStatusChoice(statuses, locales));
    // 7. Consent — optional on Google One, skip silently if absent.
    try {
      const box = await visibleField(page, selectors.consent, 'consent',
        Math.min(5000, config.timeouts.actionMs));
      if (!(await box.isChecked())) {
        if (interaction?.click) await interaction.click(box);
        else await box.check();
        log('field_filled', { stage: 'fill', field: 'consent', note: 'auto-checked' });
      } else {
        log('field_filled', { stage: 'fill', field: 'consent', note: 'already-checked' });
      }
    } catch {
      log('field_skipped', { stage: 'fill', field: 'consent', reason: 'not present' });
    }
  },
};
