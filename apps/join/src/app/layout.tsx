import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "Sumate al programa",
  // La landing se abre desde un QR en una mesa: no tiene por qué aparecer en
  // buscadores, y que no aparezca evita que un cliente llegue por Google a la
  // página de alta de un comercio que no visitó.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
