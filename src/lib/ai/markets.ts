/**
 * The GCC markets a sponsor can be in — shared by the agent (the market a
 * contact is tagged with), search_maids (the market filter) and outreach
 * (tagging a prospect from the ad's city).
 */

/**
 * The GCC markets a sponsor can be in, keyed by ISO code, with the
 * currency candidates are priced in for that market and the spellings a
 * customer (or our own outreach message) uses for it. The public maid view
 * carries no "destination country" column — the maid's preferred countries
 * live in a jsonb the view does not expose — so `preferred_currency` is the
 * one field that says which market a candidate is priced for: a maid at
 * 120–150 KWD/mo is a Kuwait candidate, whatever her current location.
 */
export const GCC_MARKETS: Array<{ iso: string; currency: string; name: string; places: string[] }> = [
  { iso: 'AE', currency: 'AED', name: 'UAE', places: ['uae', 'united arab emirates', 'emirates', 'dubai', 'abu dhabi', 'sharjah', 'ajman', 'fujairah', 'ras al khaimah', 'rak', 'umm al quwain', 'al ain', 'al shamkha', 'khalifa city', 'jumeirah', 'deira'] },
  { iso: 'SA', currency: 'SAR', name: 'Saudi Arabia', places: ['saudi', 'saudi arabia', 'ksa', 'riyadh', 'al riyadh', 'jeddah', 'jiddah', 'dammam', 'al ahsa', 'al hasa', 'hofuf', 'al khobar', 'khobar', 'dhahran', 'jubail', 'mecca', 'makkah', 'medina', 'madinah', 'tabuk', 'abha', 'taif', 'qatif', 'buraidah', 'hail', 'najran', 'yanbu'] },
  { iso: 'KW', currency: 'KWD', name: 'Kuwait', places: ['kuwait', 'kuwait city', 'hawalli', 'salmiya', 'farwaniya', 'jahra', 'ahmadi', 'mubarak al kabeer'] },
  { iso: 'QA', currency: 'QAR', name: 'Qatar', places: ['qatar', 'doha', 'al rayyan', 'al wakrah', 'lusail', 'al khor'] },
  { iso: 'BH', currency: 'BHD', name: 'Bahrain', places: ['bahrain', 'manama', 'muharraq', 'riffa', 'isa town', 'hamad town'] },
  { iso: 'OM', currency: 'OMR', name: 'Oman', places: ['oman', 'muscat', 'salalah', 'sohar', 'seeb', 'nizwa', 'sur'] },
];

export interface SponsorMarket {
  iso: string;
  currency: string;
  name: string;
}

/**
 * The market behind whatever the customer said about where they are —
 * an ISO code, a country, an emirate, a city, or a longer phrase such as
 * "Al Shamkha, Abu Dhabi". Whole words only, so "Romania" is not Oman.
 * Null outside the GCC. Pure — exported for tests.
 */
export function resolveSponsorCountry(input: unknown): SponsorMarket | null {
  if (typeof input !== 'string') return null;
  const text = input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!text) return null;
  const upper = input.trim().toUpperCase();
  for (const market of GCC_MARKETS) {
    if (upper === market.iso) return { iso: market.iso, currency: market.currency, name: market.name };
  }
  // Longest spelling first so "abu dhabi" beats nothing shorter that might sit inside it.
  const candidates = GCC_MARKETS.flatMap((m) => m.places.map((place) => ({ place, market: m })))
    .sort((a, b) => b.place.length - a.place.length);
  for (const { place, market } of candidates) {
    const re = new RegExp(`(^|\\s)${place.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
    if (re.test(text)) return { iso: market.iso, currency: market.currency, name: market.name };
  }
  return null;
}

