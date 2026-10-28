/**
 * The photo is a data URL that already lives in the in-memory snapshot.
 * It is never fetched from a URL and never written anywhere.
 */
export function Photo(props: { src: string; alt: string }) {
  return (
    <img
      class="card-photo"
      src={props.src}
      alt={props.alt}
      width="240"
      height="320"
      decoding="async"
      draggable="false"
    />
  );
}
