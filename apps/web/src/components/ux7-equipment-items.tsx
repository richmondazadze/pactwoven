import { Icon } from './icon';

export const equipmentDollars = (minor: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(minor / 100);
type EquipmentItem = { id: string; label: string; seats: number; microphones: number; projectors: number; priceMinor: number };

/** Display the recorded selection verbatim; no output parsing or package recomputation. */
export function EquipmentItemList({ items, saved = false }: { items: EquipmentItem[]; saved?: boolean }) {
  return <ul className="ux7-equipment-items">{items.map(item => <li key={item.id}>
    <span className="ux7-equipment-icon"><Icon name="package" size={20}/></span>
    <div className="ux7-equipment-copy"><strong>{item.label}</strong><div className="ux7-equipment-capacity">
      <span>{item.seats} {item.seats === 1 ? 'seat' : 'seats'}</span><span>{item.microphones} {item.microphones === 1 ? 'microphone' : 'microphones'}</span><span>{item.projectors} {item.projectors === 1 ? 'projector' : 'projectors'}</span>
    </div></div>
    <div className="ux7-equipment-price"><strong>{equipmentDollars(item.priceMinor)}</strong><span>{saved ? 'Saved sample price' : 'Sample price'}</span></div>
  </li>)}</ul>;
}
