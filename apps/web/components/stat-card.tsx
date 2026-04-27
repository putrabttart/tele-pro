type Props = {
  label: string;
  value: string | number;
  helper?: string;
};

export function StatCard({ label, value, helper }: Props) {
  return (
    <article className="card">
      <div className="muted">{label}</div>
      <div className="stat">{value}</div>
      {helper ? <div className="muted">{helper}</div> : null}
    </article>
  );
}
