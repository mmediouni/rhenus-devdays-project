/**
 * Environment groups dialog: define which domains are the same app
 * (e.g. shop-test.* and shop-qa.*) so their pages can be compared.
 */

import { openModal, toast } from '../utils/ui.js';
import { saveGroups, suggestGroups, sanitizeGroups, envLabel } from '../utils/environments.js';

const BTN = 'padding:5px 12px;border-radius:6px;border:1px solid rgba(255,255,255,.2);background:#1e293b;color:inherit;cursor:pointer;font:inherit;';
const BTN_PRIMARY = BTN + 'background:#0891b2;border-color:#0891b2;';
const INPUT = 'padding:6px 8px;border-radius:6px;border:1px solid rgba(255,255,255,.2);background:#0b1220;color:inherit;font:inherit;width:100%;box-sizing:border-box;';

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  const { style, text, ...rest } = props;
  if (style) node.style.cssText = style;
  if (text !== undefined) node.textContent = text;
  Object.assign(node, rest);
  node.append(...children);
  return node;
}

/**
 * @param {Object} opts
 * @param {string[]} opts.domains   all domains found in stored snapshots
 * @param {Array}    opts.groups    current groups
 * @param {Function} opts.onChange  called (once) after the dialog closes if groups changed
 */
export function openEnvironmentsDialog({ domains, groups, onChange }) {
  let current = sanitizeGroups(groups);
  let changed = false;

  const persist = async (next) => {
    current = sanitizeGroups(next);
    changed = true;
    try {
      await saveGroups(current);
    } catch (e) {
      toast(`Could not save environment groups: ${e.message}`, 'error');
    }
  };

  openModal((root, close) => {
    const render = () => {
      root.textContent = '';

      root.append(
        el('h3', { text: 'Environment groups', style: 'margin:0 0 6px;font-size:16px;' }),
        el('p', {
          text: 'Domains in the same group are treated as one application: pages with the same path are merged, ' +
            'so you can compare e.g. TEST against QA. Existing snapshots are merged automatically.',
          style: 'margin:0 0 14px;opacity:.8;'
        })
      );

      // Existing groups
      if (current.length) {
        const list = el('div', { style: 'display:flex;flex-direction:column;gap:8px;margin-bottom:14px;' });
        current.forEach((g, idx) => {
          const row = el('div', { style: 'border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:8px 10px;' });
          row.append(el('div', { text: g.name, style: 'font-weight:700;margin-bottom:4px;' }));
          g.domains.forEach(d => {
            row.append(el('div', { text: `${envLabel(d, current)}  —  ${d}`, style: 'font-size:12px;opacity:.85;word-break:break-all;' }));
          });
          row.append(el('button', {
            text: 'Remove group',
            style: BTN + 'margin-top:6px;',
            onclick: async () => {
              await persist(current.filter((_, i) => i !== idx));
              render();
            }
          }));
          list.append(row);
        });
        root.append(list);
      }

      // Suggestions
      const suggestions = suggestGroups(domains, current);
      if (suggestions.length) {
        root.append(el('div', { text: 'Suggested groups', style: 'font-weight:700;margin-bottom:6px;' }));
        suggestions.forEach(s => {
          const row = el('div', { style: 'display:flex;gap:10px;align-items:center;justify-content:space-between;border:1px dashed rgba(6,182,212,.6);border-radius:8px;padding:8px 10px;margin-bottom:8px;' });
          row.append(
            el('div', { style: 'font-size:12px;word-break:break-all;' },
              el('strong', { text: s.name }),
              document.createElement('br'),
              document.createTextNode(s.domains.join('  •  '))),
            el('button', {
              text: 'Create',
              style: BTN_PRIMARY,
              onclick: async () => {
                await persist([...current, s]);
                render();
              }
            })
          );
          root.append(row);
        });
      }

      // Manual creation
      root.append(el('div', { text: 'Create a group manually', style: 'font-weight:700;margin:12px 0 6px;' }));
      const nameInput = el('input', { placeholder: 'Group name (e.g. shop)', style: INPUT + 'margin-bottom:8px;' });
      const checks = el('div', { style: 'display:flex;flex-direction:column;gap:4px;max-height:160px;overflow:auto;margin-bottom:8px;' });
      const boxes = [];
      domains.forEach(d => {
        const cb = el('input', { type: 'checkbox', value: d });
        boxes.push(cb);
        checks.append(el('label', { style: 'font-size:12px;display:flex;gap:6px;align-items:center;word-break:break-all;' }, cb, document.createTextNode(d)));
      });
      if (!domains.length) checks.append(el('div', { text: 'No snapshots recorded yet.', style: 'opacity:.7;' }));

      const addBtn = el('button', {
        text: 'Add group',
        style: BTN_PRIMARY,
        onclick: async () => {
          const selected = boxes.filter(b => b.checked).map(b => b.value);
          if (selected.length < 2) return toast('Select at least two domains.', 'warn');
          if (selected.some(d => current.some(g => g.domains.includes(d)))) {
            return toast('A domain can only belong to one group.', 'warn');
          }
          await persist([...current, { name: nameInput.value.trim() || 'Group', domains: selected }]);
          render();
        }
      });
      root.append(nameInput, checks, addBtn);

      root.append(el('div', { style: 'text-align:right;margin-top:14px;' },
        el('button', { text: 'Done', style: BTN, onclick: close })));
    };

    render();
  }, {
    onClose: () => { if (changed && onChange) onChange(); }
  });
}
