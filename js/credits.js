// Credits panel, built from data/sources.json.
import { esc } from './tooltip.js';

const link = (url, text) => `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>`;

export async function renderCredits(el) {
  let src;
  try {
    const res = await fetch('data/sources.json');
    if (!res.ok) throw new Error(res.status);
    src = await res.json();
  } catch {
    return; // keep the static fallback already in the page
  }
  el.innerHTML = `
    <h2>Credits</h2>
    <p class="cr-author">Made by ${link(src.author.url, src.author.name)}
      · ${link(src.author.repo, 'source on GitHub')}</p>
    <h3>Data references</h3>
    <ul class="cr-list">${src.data.map(d => `
      <li>${link(d.url, d.title)}<br>
        <span class="cr-meta">${esc(d.author)} · ${esc(d.license)}</span><br>
        <span class="cr-use">${esc(d.used_for)}</span>
        ${d.citation ? `<br><span class="cr-cite">${esc(d.citation)}</span>` : ''}</li>`).join('')}
    </ul>
    <h3>Fonts</h3>
    <p class="cr-fonts">${src.fonts.map(f => `${link(f.url, f.title)} (${esc(f.license)})`).join(' · ')}</p>
    <ul class="cr-notes">${src.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>`;
}
