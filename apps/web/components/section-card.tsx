type Props = {
  title: string;
  description?: string;
  children: React.ReactNode;
};

export function SectionCard({ title, description, children }: Props) {
  return (
    <section className="card">
      <h2 className="section-title">{title}</h2>
      {description ? <p className="section-desc">{description}</p> : null}
      {children}
    </section>
  );
}
