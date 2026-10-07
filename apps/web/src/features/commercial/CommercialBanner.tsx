import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { BILLING_PATH, NON_OWNER_HINT, READ_ONLY_MESSAGE, bannerFor } from "./commercialLogic";
import { useCommercial } from "./CommercialProvider";

// Banner comercial persistente (Administrativo e áreas operacionais). active/unmanaged: nada. O aviso de PT402 é a
// mensagem amigável central (ver wrapFetchForReadOnly): aparece quando uma ação é barrada, com a ação de regularizar.
export function CommercialBanner() {
  const { info, readOnlyNoticeAt, dismissReadOnlyNotice } = useCommercial();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const banner = bannerFor(info, now);
  const isOwner = info?.is_owner === true;
  if (!banner && readOnlyNoticeAt === null) return null;

  return (
    <div className="commercial-banners">
      {banner && (
        <div className={`commercial-banner commercial-banner-${banner.tone}`} role="status">
          <span>
            {banner.text}
            {!isOwner && banner.tone !== "info" ? ` ${NON_OWNER_HINT}` : ""}
          </span>
          {banner.action && isOwner && (
            <Link className="btn-secondary btn-small" to={BILLING_PATH}>
              {info?.state === "pending_payment" || info?.state === "trial_expired" || info?.state === "canceled" ? "Ver pagamento" : "Regularizar assinatura"}
            </Link>
          )}
        </div>
      )}
      {readOnlyNoticeAt !== null && (
        <div className="commercial-banner commercial-banner-danger" role="alert">
          <span>{READ_ONLY_MESSAGE}</span>
          {isOwner && (
            <Link className="btn-secondary btn-small" to={BILLING_PATH} onClick={dismissReadOnlyNotice}>
              Ver pagamento
            </Link>
          )}
          <button type="button" className="btn-secondary btn-small" onClick={dismissReadOnlyNotice}>
            Fechar
          </button>
        </div>
      )}
    </div>
  );
}
