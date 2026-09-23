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
    <details class="cr-section">
      <summary><h3>Data references <span class="cr-count">${src.data.length} sources</span></h3></summary>
    <div class="cr-acc">${src.data.map(d => `
      <details>
        <summary>${esc(d.title)}<span class="cr-lic">${esc(d.license)}</span></summary>
        <div class="cr-body">
          <p class="cr-meta">${esc(d.author)}</p>
          <p class="cr-use">${esc(d.used_for)}</p>
          ${d.citation ? `<p class="cr-cite">${esc(d.citation)}</p>` : ''}
          <p>${link(d.url, 'Source')}${[].concat(d.download || []).map((u, i) => ` · ${link(u, 'Download' + (i ? ' ' + (i + 1) : ''))}`).join('')}</p>
        </div>
      </details>`).join('')}
    </div>
    </details>
    <h3>Fonts</h3>
    <p class="cr-fonts">${src.fonts.map(f => `${link(f.url, f.title)} (${esc(f.license)})`).join(' · ')}</p>
    <ul class="cr-notes">${src.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>`;
}
