import { notFound } from "next/navigation";

import { fetchBranding } from "../../lib/api";
import { EnrollForm } from "./enroll-form";

export default async function JoinPage({
  params,
}: {
  params: Promise<{ merchant: string }>;
}) {
  const { merchant } = await params;
  const branding = await fetchBranding(merchant);

  if (!branding) notFound();

  return (
    <main>
      {/* Vista previa de la tarjeta que va a recibir: lo que se pide a
          continuación (celular, consentimientos) se entiende mucho mejor si
          antes se ve qué se está por obtener. */}
      <section className="card" style={{ background: branding.backgroundColor }}>
        {branding.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="card__logo" src={branding.logoUrl} alt="" />
        ) : null}
        <p className="card__merchant">{branding.displayName}</p>
        <h1 className="card__program">{branding.programName}</h1>
      </section>

      <EnrollForm
        slug={branding.slug}
        merchantName={branding.displayName}
        accent={branding.backgroundColor}
      />

      <p className="footer">
        Tu tarjeta la emite Sophos Group EAS en nombre de {branding.displayName}.
        <br />
        Podés darte de baja en cualquier momento desde el dorso de la tarjeta.
      </p>
    </main>
  );
}
