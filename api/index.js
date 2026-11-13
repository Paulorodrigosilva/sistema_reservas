resourceSelect.addEventListener('change', () => {
  updateVehicleFields();
  fillSuggestedOdometer(); // <- Remova esta linha
});
reservationForm.elements.inicio.addEventListener('change', fillSuggestedOdometer); // <- Remova ou comente esta linha
