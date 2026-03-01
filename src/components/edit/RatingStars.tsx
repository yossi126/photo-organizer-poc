interface RatingStarsProps {
  rating: number;
  onChange: (stars: number) => void;
}

export function RatingStars({ rating, onChange }: RatingStarsProps) {
  return (
    <div className="flex gap-1">
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          onClick={() => onChange(star === rating ? 0 : star)}
          className="text-xl transition-colors"
          style={{ color: star <= rating ? "#fbbf24" : "#3f3f46" }}
        >
          ★
        </button>
      ))}
    </div>
  );
}
