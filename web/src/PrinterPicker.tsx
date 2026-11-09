// Choosing a printer from every vendor bundled with BOSS: vendors on the left,
// their printers on the right, and a search over all of them. Printer presets users
// saved come first, under "My printers".

import { useMemo, useState } from "react";
import { requestPresets, useStore } from "./store";
import type { CatalogVendor } from "./types";

const MINE = "@mine";

// "Ender-3 V2" and "ender 3 v2" match: lower case, punctuation as spaces
function normalize(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9.]+/g, " ").trim();
}

export function PrinterPicker({ onClose }: { onClose: () => void }) {
  const bundled = useStore((s) => s.catalog ?? []);
  const userPrinters = useStore((s) => s.userPrinters);
  const current = useStore((s) => s.plate?.presets);

  // The user's printers as one more "vendor"; each remembers the vendor it belongs to
  const catalog = useMemo(() => {
    if (userPrinters.length === 0) return bundled;
    const names = new Map(bundled.map((v) => [v.id, v.name]));
    const mine: CatalogVendor = {
      id: MINE,
      name: "My printers",
      models: [...new Set(userPrinters.map((p) => p.vendor))].map((vendor) => ({
        id: vendor,
        name: names.get(vendor) ?? vendor,
        family: "",
        printers: userPrinters.filter((p) => p.vendor === vendor).map((p) => ({ name: p.name, variant: "" })),
      })),
    };
    return [mine, ...bundled];
  }, [bundled, userPrinters]);

  const startVendor = current?.user?.printer ? MINE : current?.vendor;
  const [vendorId, setVendorId] = useState(startVendor ?? catalog[0]?.id ?? "");
  const [query, setQuery] = useState("");

  const q = query.trim();
  // While searching, every vendor's matching printers; otherwise the chosen vendor's
  const groups = useMemo(() => {
    const words = normalize(q).split(" ").filter(Boolean);
    const vendors = q ? catalog : catalog.filter((v) => v.id === vendorId);
    return vendors.flatMap((v) =>
      v.models
        .map((m) => ({
          vendor: v,
          model: m,
          printers: m.printers.filter((p) => {
            const text = ` ${normalize(`${v.name} ${m.name} ${p.name}`)} `;
            return words.every((w) => text.includes(` ${w}`));
          }),
        }))
        .filter((g) => g.printers.length > 0),
    );
  }, [catalog, vendorId, q]);

  const choose = (vendor: string, printer: string) => {
    onClose();
    // Print and filament are kept when they fit the new printer
    void requestPresets({ vendor, printer, print: current?.print, filament: current?.filament });
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal picker" role="dialog" aria-label="Choose a printer">
        <header>
          <h2>Choose a printer</h2>
          <input autoFocus placeholder="Search printers…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className="icon" onClick={onClose} title="Close">×</button>
        </header>
        <div className="picker-body">
          <ul className="vendors">
            {catalog.map((v) => (
              <li key={v.id}>
                <button
                  className={`${!q && v.id === vendorId ? "active" : ""}${v.id === MINE ? " mine" : ""}`}
                  onClick={() => {
                    setQuery("");
                    setVendorId(v.id);
                  }}
                >
                  {v.name}
                </button>
              </li>
            ))}
          </ul>
          <div className="models">
            {groups.length === 0 && <p className="hint">No printer matches “{query}”.</p>}
            {groups.map(({ vendor, model, printers }) => (
              <div key={`${vendor.id}/${model.id}`} className="model">
                <h4>{q || vendor.id === MINE ? `${vendor.name} · ` : ""}{model.name}</h4>
                {printers.map((p) => {
                  // A user printer's vendor is its model id here
                  const vendorOf = vendor.id === MINE ? model.id : vendor.id;
                  return (
                    <button
                      key={p.name}
                      className={p.name === current?.printer && vendorOf === current?.vendor ? "printer active" : "printer"}
                      onClick={() => choose(vendorOf, p.name)}
                    >
                      {p.name}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
