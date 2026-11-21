import './globals.css';

export const metadata = {
  title: 'AI Video Clipper',
  description: 'Turn long videos into short clips with AI',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
